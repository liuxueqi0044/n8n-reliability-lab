-- migrate:up
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_execution_unique;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_execution_type_unique UNIQUE (workflow_name, n8n_execution_id, run_type);

CREATE FUNCTION decide_approval(
  p_event_id text, p_decision text, p_decided_by text, p_reason text,
  p_workflow_id text, p_workflow_name text, p_n8n_execution_id text
) RETURNS TABLE (http_status integer, result_code varchar, dispatch boolean, event_id varchar, event_status varchar, decision varchar)
LANGUAGE plpgsql AS $$
DECLARE v_event inbound_events%ROWTYPE; v_request approval_requests%ROWTYPE; v_decision text := lower(btrim(p_decision)); v_by text := btrim(p_decided_by); v_reason text := NULLIF(p_reason, '');
BEGIN
  IF v_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'approval decision must be approved or rejected' USING ERRCODE = '23514'; END IF;
  IF v_by IS NULL OR length(v_by) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'decided_by must be 1 to 200 characters' USING ERRCODE = '23514'; END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 2000 THEN RAISE EXCEPTION 'reason exceeds 2000 characters' USING ERRCODE = '22001'; END IF;
  SELECT target.* INTO v_event FROM inbound_events AS target WHERE target.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 404, 'not_found'::varchar, false, NULL::varchar, NULL::varchar, v_decision::varchar; RETURN; END IF;
  SELECT request.* INTO v_request FROM approval_requests AS request WHERE request.inbound_event_id = v_event.id FOR UPDATE;
  IF NOT FOUND OR v_event.status <> 'awaiting_approval' AND v_request.decision = 'pending' THEN
    INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome, finished_at, metadata)
    VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'approval', 'skipped', now(), jsonb_build_object('result_code', 'not_approvable')) ON CONFLICT (workflow_name, n8n_execution_id, run_type) DO NOTHING;
    RETURN QUERY SELECT 409, 'not_approvable'::varchar, false, v_event.event_id, v_event.status, COALESCE(v_request.decision, v_decision)::varchar; RETURN;
  END IF;
  IF v_request.decision = 'pending' THEN
    UPDATE approval_requests AS request SET decision = v_decision, decided_at = now(), decided_by = v_by, reason = v_reason WHERE request.id = v_request.id;
    IF v_decision = 'approved' THEN UPDATE inbound_events AS target SET status = 'processing' WHERE target.id = v_event.id; ELSE UPDATE inbound_events AS target SET status = 'rejected' WHERE target.id = v_event.id; END IF;
    INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome, finished_at, metadata)
    VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'approval', 'succeeded', now(), jsonb_build_object('decision', v_decision)) ON CONFLICT (workflow_name, n8n_execution_id, run_type) DO NOTHING;
    RETURN QUERY SELECT 200, 'decided'::varchar, v_decision = 'approved', v_event.event_id, CASE WHEN v_decision = 'approved' THEN 'processing' ELSE 'rejected' END::varchar, v_decision::varchar; RETURN;
  END IF;
  INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome, finished_at, metadata)
  VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'approval', 'skipped', now(), jsonb_build_object('result_code', CASE WHEN v_request.decision = v_decision THEN 'duplicate' ELSE 'conflict' END)) ON CONFLICT (workflow_name, n8n_execution_id, run_type) DO NOTHING;
  RETURN QUERY SELECT CASE WHEN v_request.decision = v_decision THEN 200 ELSE 409 END, CASE WHEN v_request.decision = v_decision THEN 'duplicate' ELSE 'conflict' END::varchar, false, v_event.event_id, v_event.status, v_request.decision;
END;
$$;

CREATE FUNCTION prepare_delivery(p_event_id text, p_workflow_id text, p_workflow_name text, p_n8n_execution_id text)
RETURNS TABLE (dispatch boolean, result_code varchar, event_id varchar, event_status varchar, processing_cycle integer, request_payload jsonb)
LANGUAGE plpgsql AS $$
DECLARE v_event inbound_events%ROWTYPE;
BEGIN
  SELECT target.* INTO v_event FROM inbound_events AS target WHERE target.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::varchar, NULL::varchar, NULL::varchar, NULL::integer, NULL::jsonb; RETURN; END IF;
  IF v_event.status <> 'processing' THEN
    RETURN QUERY SELECT false, 'not_dispatchable'::varchar, v_event.event_id, v_event.status, v_event.processing_cycle, NULL::jsonb; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM workflow_runs AS active_run WHERE active_run.inbound_event_id = v_event.id AND active_run.run_type = 'delivery' AND active_run.outcome = 'running') THEN
    RETURN QUERY SELECT false, 'delivery_in_progress'::varchar, v_event.event_id, v_event.status, v_event.processing_cycle, NULL::jsonb; RETURN;
  END IF;
  INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome)
  VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'delivery', 'running');
  RETURN QUERY SELECT true, 'ready'::varchar, v_event.event_id, v_event.status, v_event.processing_cycle, v_event.raw_payload;
END;
$$;

CREATE FUNCTION record_delivery_attempt(
  p_event_id text, p_processing_cycle integer, p_attempt_no integer, p_http_status integer, p_request_payload jsonb,
  p_response_excerpt text, p_error_message text, p_workflow_name text, p_n8n_execution_id text
) RETURNS TABLE (action varchar, event_status varchar, retryable boolean, outcome varchar)
LANGUAGE plpgsql AS $$
DECLARE v_event inbound_events%ROWTYPE; v_attempt delivery_attempts%ROWTYPE; v_dead dead_letter_events%ROWTYPE; v_retryable boolean; v_outcome varchar(32); v_action varchar(32); v_failure_class varchar(128);
BEGIN
  IF p_attempt_no NOT BETWEEN 1 AND 3 OR p_processing_cycle < 0 OR (p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599) THEN RAISE EXCEPTION 'invalid delivery attempt parameters' USING ERRCODE = '23514'; END IF;
  IF jsonb_typeof(p_request_payload) <> 'object' THEN RAISE EXCEPTION 'request_payload must be a JSON object' USING ERRCODE = '23514'; END IF;
  SELECT target.* INTO v_event FROM inbound_events AS target WHERE target.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event not found' USING ERRCODE = 'P0002'; END IF;
  SELECT existing.* INTO v_attempt FROM delivery_attempts AS existing WHERE existing.inbound_event_id = v_event.id AND existing.processing_cycle = p_processing_cycle AND existing.attempt_no = p_attempt_no;
  IF FOUND THEN
    RETURN QUERY SELECT CASE WHEN v_event.status = 'delivered' THEN 'delivered' WHEN v_event.status = 'dead_letter' THEN 'dead_letter' WHEN v_event.status = 'processing' AND v_attempt.retryable AND v_attempt.attempt_no < 3 THEN 'retry' ELSE 'dead_letter' END::varchar, v_event.status, v_attempt.retryable, v_attempt.outcome; RETURN;
  END IF;
  IF v_event.status <> 'processing' OR v_event.processing_cycle <> p_processing_cycle THEN RAISE EXCEPTION 'event is not active for this delivery cycle' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM workflow_runs AS delivery_run WHERE delivery_run.inbound_event_id = v_event.id AND delivery_run.workflow_name = p_workflow_name AND delivery_run.n8n_execution_id = p_n8n_execution_id AND delivery_run.run_type = 'delivery' AND delivery_run.outcome = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'running delivery workflow run not found' USING ERRCODE = 'P0002'; END IF;
  v_retryable := p_http_status IS NULL OR p_http_status = 429 OR p_http_status BETWEEN 500 AND 599;
  IF p_http_status BETWEEN 200 AND 299 THEN v_outcome := 'succeeded'; v_action := 'delivered';
  ELSIF v_retryable AND p_attempt_no < 3 THEN v_outcome := 'retryable_failure'; v_action := 'retry';
  ELSE v_outcome := CASE WHEN v_retryable THEN 'retryable_failure' ELSE 'permanent_failure' END; v_action := 'dead_letter'; END IF;
  INSERT INTO delivery_attempts (inbound_event_id, processing_cycle, attempt_no, idempotency_key, outcome, http_status, retryable, request_payload, response_excerpt, error_message)
  VALUES (v_event.id, p_processing_cycle, p_attempt_no, v_event.event_id, v_outcome, p_http_status, v_retryable, p_request_payload, left(p_response_excerpt, 2000), left(p_error_message, 2000));
  IF v_action = 'retry' THEN RETURN QUERY SELECT v_action, v_event.status, true, v_outcome; RETURN; END IF;
  IF v_action = 'delivered' THEN
    UPDATE inbound_events AS target SET status = 'delivered' WHERE target.id = v_event.id;
    UPDATE workflow_runs AS delivery_run SET outcome = 'succeeded', finished_at = now(), metadata = delivery_run.metadata || jsonb_build_object('http_status', p_http_status) WHERE delivery_run.inbound_event_id = v_event.id AND delivery_run.workflow_name = p_workflow_name AND delivery_run.n8n_execution_id = p_n8n_execution_id;
    UPDATE dead_letter_events AS dead SET status = 'recovered', recovered_at = now() WHERE dead.inbound_event_id = v_event.id AND dead.status = 'recovering';
    RETURN QUERY SELECT v_action, 'delivered'::varchar, false, v_outcome; RETURN;
  END IF;
  v_failure_class := CASE WHEN p_http_status IS NULL THEN 'transport_retry_exhausted' WHEN v_retryable THEN 'retry_exhausted' ELSE 'nonretryable_http_' || p_http_status::text END;
  UPDATE inbound_events AS target SET status = 'dead_letter' WHERE target.id = v_event.id;
  INSERT INTO dead_letter_events (inbound_event_id, status, failure_class, last_http_status, attempt_count, event_snapshot)
  VALUES (v_event.id, 'open', v_failure_class, p_http_status, p_attempt_no, v_event.raw_payload)
  ON CONFLICT (inbound_event_id) DO UPDATE SET status = 'open', failure_class = EXCLUDED.failure_class, last_http_status = EXCLUDED.last_http_status, attempt_count = EXCLUDED.attempt_count, event_snapshot = EXCLUDED.event_snapshot, recovered_at = NULL;
  UPDATE workflow_runs AS delivery_run SET outcome = 'failed', finished_at = now(), error_code = v_failure_class, error_message = left(COALESCE(p_error_message, p_response_excerpt), 2000), metadata = delivery_run.metadata || jsonb_build_object('http_status', p_http_status) WHERE delivery_run.inbound_event_id = v_event.id AND delivery_run.workflow_name = p_workflow_name AND delivery_run.n8n_execution_id = p_n8n_execution_id;
  RETURN QUERY SELECT 'dead_letter'::varchar, 'dead_letter'::varchar, false, v_outcome;
END;
$$;

CREATE FUNCTION claim_dead_letter_replay(p_event_id text, p_workflow_id text, p_workflow_name text, p_n8n_execution_id text)
RETURNS TABLE (dispatch boolean, result_code varchar, event_id varchar, event_status varchar, processing_cycle integer)
LANGUAGE plpgsql AS $$
DECLARE v_event inbound_events%ROWTYPE; v_dead dead_letter_events%ROWTYPE;
BEGIN
  SELECT target.* INTO v_event FROM inbound_events AS target WHERE target.event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::varchar, NULL::varchar, NULL::varchar, NULL::integer; RETURN; END IF;
  SELECT dead.* INTO v_dead FROM dead_letter_events AS dead WHERE dead.inbound_event_id = v_event.id FOR UPDATE;
  IF v_event.status <> 'dead_letter' OR NOT FOUND OR v_dead.status <> 'open' THEN
    INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome, finished_at, metadata)
    VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'recovery', 'skipped', now(), jsonb_build_object('result_code', 'not_replayable')) ON CONFLICT (workflow_name, n8n_execution_id, run_type) DO NOTHING;
    RETURN QUERY SELECT false, 'not_replayable'::varchar, v_event.event_id, v_event.status, v_event.processing_cycle; RETURN;
  END IF;
  UPDATE dead_letter_events AS dead SET status = 'recovering', replay_count = dead.replay_count + 1 WHERE dead.id = v_dead.id;
  UPDATE inbound_events AS target SET status = 'processing', processing_cycle = target.processing_cycle + 1 WHERE target.id = v_event.id RETURNING target.processing_cycle INTO processing_cycle;
  INSERT INTO workflow_runs (inbound_event_id, workflow_id, workflow_name, n8n_execution_id, run_type, outcome, finished_at, metadata)
  VALUES (v_event.id, p_workflow_id, p_workflow_name, p_n8n_execution_id, 'recovery', 'succeeded', now(), jsonb_build_object('result_code', 'claimed'));
  RETURN QUERY SELECT true, 'claimed'::varchar, v_event.event_id, 'processing'::varchar, processing_cycle;
END;
$$;

-- migrate:down
DROP FUNCTION IF EXISTS claim_dead_letter_replay(text, text, text, text);
DROP FUNCTION IF EXISTS record_delivery_attempt(text, integer, integer, integer, jsonb, text, text, text, text);
DROP FUNCTION IF EXISTS prepare_delivery(text, text, text, text);
DROP FUNCTION IF EXISTS decide_approval(text, text, text, text, text, text, text);
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_execution_type_unique;
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_execution_unique;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_execution_unique UNIQUE (workflow_name, n8n_execution_id);
