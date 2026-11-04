-- unifi_logs.log_events: one row per log line, with the fields the saved
-- queries need. CDK creates this view from this file, and the saved query
-- "00 Recreate log_events view" runs the same SQL if you edit it in Athena.
--
-- Every column is CAST to a fixed type so Athena doesn't mark the view stale.
SELECT
  CAST(from_iso8601_timestamp("timestamp") AS timestamp(3)) AS event_time,
  CAST(source AS varchar)                                    AS source,
  CAST(host AS varchar)                                      AS host,
  CAST(hostname AS varchar)                                  AS hostname,
  CAST(program AS varchar)                                   AS program,
  CAST(lower(severity) AS varchar)                           AS severity,
  CAST(message AS varchar)                                   AS message,
  CAST(concat(year, '-', month, '-', day) AS varchar)        AS log_date,

  -- ════════════════════════════════════════════════════════════════════════
  -- MATCH PATTERNS. Edit these once you've seen real log lines.
  --
  -- None of these patterns have been checked against your logs yet. They're
  -- broad starting points. See "Checking the match patterns" in README.md.
  -- Rows that match nothing get event_type NULL and are still queryable.
  -- ════════════════════════════════════════════════════════════════════════

  -- Which device a line is about. Controller lines name devices as
  -- dev[AA-BB-CC-DD-EE-FF]; device syslog lines use the sender's hostname or IP.
  CAST(coalesce(
    regexp_extract(message, 'dev\[([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\]', 1),
    nullif(hostname, ''),
    host
  ) AS varchar) AS device,

  -- Lines from the home gateway, used by the log-gap query.
  -- 192.168.1.1 is the Glasgow USG's LAN address.
  CAST(source = 'devices' AND host = '192.168.1.1' AS boolean) AS is_gateway,

  -- First match wins, so SLA lines are checked before generic WAN lines.
  CAST(CASE
    WHEN regexp_like(message, '(?i)\b(sla|wlb|load.?balanc\w*|failover)\b.*\b(fail\w*|breach\w*|unreachable|down|inactive)\b')
      THEN 'sla_breach'
    WHEN regexp_like(message, '(?i)\b(sla|wlb|load.?balanc\w*|failover)\b.*\b(recover\w*|restored|reachable|active|up)\b')
      THEN 'sla_recovery'
    WHEN regexp_like(message, '(?i)\b(wan\d?|eth0|pppoe\d?|internet)\b.*\b(down|offline|disconnected|lost|unreachable)\b')
      THEN 'wan_down'
    WHEN regexp_like(message, '(?i)\b(wan\d?|eth0|pppoe\d?|internet)\b.*\b(up|online|connected|restored)\b')
      THEN 'wan_up'
    WHEN regexp_like(message, '(?i)(lost contact|EVT_\w+_Lost_Contact|heartbeat (missed|lost)|\bdisconnected\b)')
      THEN 'device_disconnect'
    WHEN regexp_like(message, '(?i)(EVT_\w+_(Connected|Adopted|Reconnected)|\breconnected\b|\bwas connected\b)')
      THEN 'device_reconnect'
  END AS varchar) AS event_type
  -- ════════════════════════ END OF MATCH PATTERNS ═════════════════════════

FROM unifi_logs.logs
