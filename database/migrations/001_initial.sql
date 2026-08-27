-- migrate:up
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(128),
  source varchar(64),
  occurred_at timestamptz,
  lead_name varchar(200),
  lead_email varchar(320),
  company_size integer,
  message text,
  raw_payload jsonb NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'received',
  classification varchar(32),
  requires_approval boolean NOT NULL DEFAULT false,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  processing_cycle integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  rejected_at timestamptz,
  CONSTRAINT inbound_events_event_id_not_blank CHECK (event_id IS NULL OR btrim(event_id) <> ''),
  CONSTRAINT inbound_events_event_id_unique UNIQUE (event_id),
  CONSTRAINT inbound_events_company_size_range CHECK (company_size IS NULL OR company_size BETWEEN 0 AND 1000000),
  CONSTRAINT inbound_events_message_length CHECK (message IS NULL OR length(message) <= 5000),
  CONSTRAINT inbound_events_status_valid CHECK (status IN ('received', 'validated', 'awaiting_approval', 'processing', 'delivered', 'rejected', 'dead_letter')),
  CONSTRAINT inbound_events_classification_valid CHECK (classification IS NULL OR classification IN ('standard', 'high_value', 'high_risk')),
  CONSTRAINT inbound_events_validation_errors_array CHECK (jsonb_typeof(validation_errors) = 'array'),
  CONSTRAINT inbound_events_processing_cycle_nonnegative CHECK (processing_cycle >= 0),
  CONSTRAINT inbound_events_version_nonnegative CHECK (version >= 0)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id uuid NOT NULL REFERENCES inbound_events(id) ON DELETE RESTRICT,
  workflow_id varchar(64) NOT NULL,
  workflow_name varchar(128) NOT NULL,
  n8n_execution_id varchar(128) NOT NULL,
  run_type varchar(32) NOT NULL CHECK (run_type IN ('intake', 'delivery', 'approval', 'recovery')),
  outcome varchar(32) NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code varchar(128),
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT workflow_runs_execution_unique UNIQUE (workflow_name, n8n_execution_id),
  CONSTRAINT workflow_runs_finished_consistent CHECK ((outcome = 'running' AND finished_at IS NULL) OR (outcome <> 'running' AND finished_at IS NOT NULL)),
  CONSTRAINT workflow_runs_error_message_length CHECK (error_message IS NULL OR length(error_message) <= 2000),
  CONSTRAINT workflow_runs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inbound_event_id uuid NOT NULL REFERENCES inbound_events(id) ON DELETE RESTRICT,
  processing_cycle integer NOT NULL CHECK (processing_cycle >= 0),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  idempotency_key varchar(200) NOT NULL,
  outcome varchar(32) NOT NULL CHECK (outcome IN ('succeeded', 'retryable_failure', 'permanent_failure')),
  http_status integer,
  retryable boolean NOT NULL,
  request_payload jsonb NOT NULL,
  response_excerpt text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_attempts_unique_attempt UNIQUE (inbound_event_id, processing_cycle, attempt_no),
  CONSTRAINT delivery_attempts_http_status_range CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT delivery_attempts_payload_object CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT delivery_attempts_response_excerpt_length CHECK (response_excerpt IS NULL OR length(response_excerpt) <= 2000),
  CONSTRAINT delivery_attempts_error_message_length CHECK (error_message IS NULL OR length(error_message) <= 2000),
  CONSTRAINT delivery_attempts_outcome_consistent CHECK (
    (outcome = 'succeeded' AND retryable = false AND http_status BETWEEN 200 AND 299) OR
    (outcome = 'retryable_failure' AND retryable = true) OR
    (outcome = 'permanent_failure' AND retryable = false)
  )
);

CREATE UNIQUE INDEX delivery_attempts_one_success_per_event ON delivery_attempts (inbound_event_id) WHERE outcome = 'succeeded';

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id uuid NOT NULL UNIQUE REFERENCES inbound_events(id) ON DELETE RESTRICT,
  decision varchar(32) NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by varchar(200),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_decision_consistent CHECK (
    (decision = 'pending' AND decided_at IS NULL AND decided_by IS NULL) OR
    (decision IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT approval_requests_reason_length CHECK (reason IS NULL OR length(reason) <= 2000)
);

CREATE TABLE dead_letter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id uuid NOT NULL UNIQUE REFERENCES inbound_events(id) ON DELETE RESTRICT,
  status varchar(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'recovering', 'recovered')),
  failure_class varchar(128) NOT NULL,
  last_http_status integer,
  attempt_count integer NOT NULL CHECK (attempt_count >= 1),
  event_snapshot jsonb NOT NULL,
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  CONSTRAINT dead_letter_events_http_status_range CHECK (last_http_status IS NULL OR last_http_status BETWEEN 100 AND 599),
  CONSTRAINT dead_letter_events_snapshot_object CHECK (jsonb_typeof(event_snapshot) = 'object'),
  CONSTRAINT dead_letter_events_recovered_consistent CHECK ((status = 'recovered' AND recovered_at IS NOT NULL) OR (status IN ('open', 'recovering') AND recovered_at IS NULL))
);

CREATE INDEX inbound_events_status_updated_at_idx ON inbound_events (status, updated_at);
CREATE INDEX inbound_events_classification_status_idx ON inbound_events (classification, status);
CREATE INDEX workflow_runs_event_started_at_idx ON workflow_runs (inbound_event_id, started_at DESC);
CREATE INDEX delivery_attempts_event_cycle_attempt_idx ON delivery_attempts (inbound_event_id, processing_cycle, attempt_no);
CREATE INDEX approval_requests_decision_requested_at_idx ON approval_requests (decision, requested_at);
CREATE INDEX dead_letter_events_status_updated_at_idx ON dead_letter_events (status, updated_at);

CREATE FUNCTION set_inbound_event_update_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.status = NEW.status) OR
    (OLD.status = 'received' AND NEW.status IN ('validated', 'rejected')) OR
    (OLD.status = 'validated' AND NEW.status IN ('awaiting_approval', 'processing')) OR
    (OLD.status = 'awaiting_approval' AND NEW.status IN ('processing', 'rejected')) OR
    (OLD.status = 'processing' AND NEW.status IN ('delivered', 'dead_letter')) OR
    (OLD.status = 'dead_letter' AND NEW.status = 'processing')) THEN
    RAISE EXCEPTION 'invalid inbound event status transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  IF OLD.status <> 'delivered' AND NEW.status = 'delivered' AND NEW.delivered_at IS NULL THEN NEW.delivered_at := now(); END IF;
  IF OLD.status <> 'rejected' AND NEW.status = 'rejected' AND NEW.rejected_at IS NULL THEN NEW.rejected_at := now(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbound_events_update_trigger BEFORE UPDATE ON inbound_events FOR EACH ROW EXECUTE FUNCTION set_inbound_event_update_fields();

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;
CREATE TRIGGER approval_requests_updated_at_trigger BEFORE UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dead_letter_events_updated_at_trigger BEFORE UPDATE ON dead_letter_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION claim_inbound_event(p_event_id text, p_raw_payload jsonb)
RETURNS TABLE (id uuid, event_id varchar, claimed boolean, status varchar, created_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE v_event_id text := NULLIF(btrim(p_event_id), '');
BEGIN
  IF v_event_id IS NOT NULL AND length(v_event_id) > 128 THEN RAISE EXCEPTION 'event_id exceeds 128 characters' USING ERRCODE = '22001'; END IF;
  IF v_event_id IS NULL THEN
    INSERT INTO inbound_events (event_id, raw_payload) VALUES (NULL, COALESCE(p_raw_payload, '{}'::jsonb))
    RETURNING inbound_events.id, inbound_events.event_id, true, inbound_events.status, inbound_events.created_at INTO id, event_id, claimed, status, created_at;
    RETURN NEXT; RETURN;
  END IF;
  INSERT INTO inbound_events (event_id, raw_payload) VALUES (v_event_id, COALESCE(p_raw_payload, '{}'::jsonb))
  ON CONFLICT ON CONSTRAINT inbound_events_event_id_unique DO NOTHING
  RETURNING inbound_events.id, inbound_events.event_id, true, inbound_events.status, inbound_events.created_at INTO id, event_id, claimed, status, created_at;
  IF FOUND THEN RETURN NEXT; RETURN; END IF;
  SELECT e.id, e.event_id, false, e.status, e.created_at INTO id, event_id, claimed, status, created_at FROM inbound_events AS e WHERE e.event_id = v_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event claim conflict could not be read'; END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION finalize_intake(
  p_inbound_event_id uuid, p_source text, p_occurred_at timestamptz, p_lead_name text,
  p_lead_email text, p_company_size integer, p_message text, p_validation_errors jsonb,
  p_classification text, p_requires_approval boolean, p_workflow_name text, p_n8n_execution_id text
) RETURNS TABLE (event_id varchar, status varchar, classification varchar, requires_approval boolean, validation_errors jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_event inbound_events%ROWTYPE; v_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb); v_status varchar(32); v_classification varchar(32);
BEGIN
  IF jsonb_typeof(v_errors) <> 'array' THEN RAISE EXCEPTION 'validation_errors must be a JSON array' USING ERRCODE = '23514'; END IF;
  IF p_requires_approval IS NULL THEN RAISE EXCEPTION 'requires_approval must not be NULL' USING ERRCODE = '23514'; END IF;
  SELECT target.* INTO v_event FROM inbound_events AS target WHERE target.id = p_inbound_event_id AND target.status = 'received' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'received inbound event % not found', p_inbound_event_id USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM workflow_runs AS intake_run WHERE intake_run.inbound_event_id = p_inbound_event_id AND intake_run.workflow_name = p_workflow_name AND intake_run.n8n_execution_id = p_n8n_execution_id AND intake_run.outcome = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'running workflow run % / % not found', p_workflow_name, p_n8n_execution_id USING ERRCODE = 'P0002'; END IF;
  IF jsonb_array_length(v_errors) > 0 THEN
    UPDATE inbound_events AS target SET source = p_source, occurred_at = p_occurred_at, lead_name = p_lead_name, lead_email = p_lead_email, company_size = p_company_size, message = p_message, validation_errors = v_errors, classification = NULL, requires_approval = false, status = 'rejected' WHERE target.id = p_inbound_event_id;
    v_status := 'rejected'; v_classification := NULL;
  ELSE
    IF p_source IS NULL OR p_occurred_at IS NULL OR p_lead_name IS NULL OR p_lead_email IS NULL OR p_company_size IS NULL OR p_message IS NULL OR p_classification IS NULL THEN RAISE EXCEPTION 'valid intake requires all normalized fields and classification' USING ERRCODE = '23514'; END IF;
    IF p_classification NOT IN ('standard', 'high_value', 'high_risk') THEN RAISE EXCEPTION 'invalid classification: %', p_classification USING ERRCODE = '23514'; END IF;
    IF (p_requires_approval AND p_classification NOT IN ('high_value', 'high_risk')) OR (NOT p_requires_approval AND p_classification <> 'standard') THEN RAISE EXCEPTION 'classification and approval requirement are inconsistent' USING ERRCODE = '23514'; END IF;
    UPDATE inbound_events AS target SET source = p_source, occurred_at = p_occurred_at, lead_name = p_lead_name, lead_email = p_lead_email, company_size = p_company_size, message = p_message, validation_errors = v_errors, classification = p_classification, requires_approval = p_requires_approval, status = 'validated' WHERE target.id = p_inbound_event_id;
    IF p_requires_approval THEN
      UPDATE inbound_events AS target SET status = 'awaiting_approval' WHERE target.id = p_inbound_event_id;
      INSERT INTO approval_requests (inbound_event_id, decision) VALUES (p_inbound_event_id, 'pending');
      v_status := 'awaiting_approval';
    ELSE
      UPDATE inbound_events AS target SET status = 'processing' WHERE target.id = p_inbound_event_id;
      v_status := 'processing';
    END IF;
    v_classification := p_classification;
  END IF;
  UPDATE workflow_runs AS intake_run SET outcome = 'succeeded', finished_at = now(), metadata = intake_run.metadata || jsonb_build_object('final_status', v_status, 'final_classification', v_classification, 'requires_approval', COALESCE(p_requires_approval, false)) WHERE intake_run.inbound_event_id = p_inbound_event_id AND intake_run.workflow_name = p_workflow_name AND intake_run.n8n_execution_id = p_n8n_execution_id;
  RETURN QUERY SELECT e.event_id, e.status, e.classification, e.requires_approval, e.validation_errors FROM inbound_events e WHERE e.id = p_inbound_event_id;
END;
$$;

-- migrate:down
DROP FUNCTION IF EXISTS finalize_intake(uuid, text, timestamptz, text, text, integer, text, jsonb, text, boolean, text, text);
DROP FUNCTION IF EXISTS claim_inbound_event(text, jsonb);
DROP TRIGGER IF EXISTS dead_letter_events_updated_at_trigger ON dead_letter_events;
DROP TRIGGER IF EXISTS approval_requests_updated_at_trigger ON approval_requests;
DROP TRIGGER IF EXISTS inbound_events_update_trigger ON inbound_events;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS set_inbound_event_update_fields();
DROP TABLE IF EXISTS dead_letter_events;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS delivery_attempts;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS inbound_events;
