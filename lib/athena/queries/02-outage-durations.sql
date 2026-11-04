-- name: 02 Outage durations
-- description: Pairs each WAN down event with the next WAN up event and computes the outage length. Parameters: start date, end date ('YYYY-MM-DD', UTC, inclusive).
WITH ev AS (
  SELECT event_time, event_type,
         lag(event_type) OVER (ORDER BY event_time) AS prev_type
  FROM unifi_logs.log_events
  WHERE log_date BETWEEN ? AND ?
    AND event_type IN ('wan_down', 'wan_up')
),
-- Several sources can report the same outage, so only the first down event
-- in a run of down events starts an outage.
outage_start AS (
  SELECT event_time AS down_at
  FROM ev
  WHERE event_type = 'wan_down' AND (prev_type IS NULL OR prev_type <> 'wan_down')
),
up AS (
  SELECT event_time AS up_at FROM ev WHERE event_type = 'wan_up'
)
SELECT s.down_at,
       min(u.up_at) AS up_at,
       date_diff('second', s.down_at, min(u.up_at)) AS duration_seconds,
       round(date_diff('second', s.down_at, min(u.up_at)) / 60.0, 1) AS duration_minutes
FROM outage_start s
LEFT JOIN up u ON u.up_at > s.down_at
GROUP BY s.down_at
ORDER BY s.down_at;
-- up_at is empty when no up event followed within the date range.
