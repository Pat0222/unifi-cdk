-- name: 03 Device disconnects and reconnects
-- description: Disconnect and reconnect counts per device, with first and last occurrence. Parameters: start date, end date ('YYYY-MM-DD', UTC, inclusive).
SELECT device,
       count_if(event_type = 'device_disconnect') AS disconnects,
       count_if(event_type = 'device_reconnect')  AS reconnects,
       min(event_time) AS first_event,
       max(event_time) AS last_event
FROM unifi_logs.log_events
WHERE log_date BETWEEN ? AND ?
  AND event_type IN ('device_disconnect', 'device_reconnect')
GROUP BY device
ORDER BY disconnects DESC, device;
