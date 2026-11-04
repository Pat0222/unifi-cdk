-- name: 04 Gateway log gaps
-- description: Periods longer than N minutes with no log lines from the gateway. Catches outages whose down event was lost. Parameters: start date, end date ('YYYY-MM-DD', UTC, inclusive), N minutes.
WITH gw AS (
  SELECT event_time,
         lag(event_time) OVER (ORDER BY event_time) AS prev_time
  FROM unifi_logs.log_events
  WHERE log_date BETWEEN ? AND ?
    AND is_gateway
)
SELECT prev_time AS last_line_before_gap,
       event_time AS first_line_after_gap,
       round(date_diff('second', prev_time, event_time) / 60.0, 1) AS gap_minutes
FROM gw
WHERE prev_time IS NOT NULL
  AND date_diff('second', prev_time, event_time) > ? * 60
ORDER BY prev_time;
-- A quiet gateway also leaves gaps, so compare against query 01 before
-- treating a gap as an outage.
