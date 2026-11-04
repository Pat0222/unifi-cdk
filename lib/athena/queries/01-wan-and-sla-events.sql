-- name: 01 WAN down/up and SLA events
-- description: Every WAN down/up and SLA breach/recovery event in a date range. Parameters: start date, end date ('YYYY-MM-DD', UTC, inclusive).
SELECT event_time, event_type, source, device, program, message
FROM unifi_logs.log_events
WHERE log_date BETWEEN ? AND ?
  AND event_type IN ('wan_down', 'wan_up', 'sla_breach', 'sla_recovery')
ORDER BY event_time;
