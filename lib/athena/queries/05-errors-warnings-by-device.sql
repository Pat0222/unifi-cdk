-- name: 05 Errors and warnings by device (last 7 days)
-- description: Count of error-or-worse and warning log lines per device and program for the last 7 days (UTC). No parameters.
SELECT device, source, program,
       count_if(severity IN ('emerg', 'emergency', 'alert', 'crit', 'critical', 'err', 'error', 'fatal')) AS errors,
       count_if(severity IN ('warn', 'warning')) AS warnings,
       max(event_time) AS last_seen
FROM unifi_logs.log_events
WHERE log_date >= date_format(current_date - INTERVAL '7' DAY, '%Y-%m-%d')
  AND severity IN ('emerg', 'emergency', 'alert', 'crit', 'critical', 'err', 'error', 'fatal', 'warn', 'warning')
GROUP BY device, source, program
ORDER BY errors DESC, warnings DESC;
