-- Shared by the controller (EC2) and the Home Assistant add-on, so both
-- write the same JSON fields:
--   timestamp  ISO 8601, UTC
--   source     "controller" or "devices"
--   host       sender IP (devices) or the controller's domain
--   hostname   from the syslog header (devices) or the EC2 instance ID
--   program    syslog program (devices) or the controller's logger name
--   severity   emerg alert crit err warning notice info debug
--   message    the log text
--   raw        the original syslog line (devices only), for checking patterns
-- Fields that aren't present are left out, and Athena reads them as NULL.

local SEVERITY = { [0] = "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug" }

local CONTROLLER_LEVEL = {
  TRACE = "debug", DEBUG = "debug", INFO = "info", WARN = "warning",
  WARNING = "warning", ERROR = "err", FATAL = "crit",
}

local UNIFI_HOST = os.getenv("UNIFI_HOST")
local UNIFI_HOSTNAME = os.getenv("UNIFI_HOSTNAME")

local function trim_end(s)
  return (s:gsub("%s+$", ""))
end

local function iso_utc(epoch_sec, ms)
  return os.date("!%Y-%m-%dT%H:%M:%S", epoch_sec) .. string.format(".%03dZ", ms)
end

local function iso_from_record_time(ts)
  local sec = math.floor(ts)
  return iso_utc(sec, math.floor((ts - sec) * 1000))
end

-- Days since 1970-01-01 for a calendar date (Howard Hinnant's algorithm).
-- Avoids os.time(), which depends on the machine's time zone.
local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local doy = math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

-- server.log: "[2026-11-02T14:12:05,706-05:00] <thread> WARN  logger - message"
-- The message can span several lines (stack traces); Lua's "." matches newlines.
function controller_record(tag, ts, record)
  local line = record["log"] or ""
  local out = { source = "controller", host = UNIFI_HOST, hostname = UNIFI_HOSTNAME }

  local y, mo, d, h, mi, s, ms, sign, oh, om, level, logger, msg = line:match(
    "^%[(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)[,%.](%d%d%d)([%+%-])(%d%d):?(%d%d)%]%s+<[^>]*>%s+(%u+)%s+(%S+)%s+%-%s+(.*)$")

  if y then
    local local_sec = days_from_civil(tonumber(y), tonumber(mo), tonumber(d)) * 86400
      + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s)
    local offset = (tonumber(oh) * 3600 + tonumber(om) * 60) * (sign == "-" and -1 or 1)
    out.timestamp = iso_utc(local_sec - offset, tonumber(ms))
    out.severity = CONTROLLER_LEVEL[level] or string.lower(level)
    out.program = logger
    out.message = trim_end(msg)
  else
    -- Unrecognized line: keep all of it, stamped with the time it was read.
    out.timestamp = iso_from_record_time(ts)
    out.message = trim_end(line)
  end
  return 2, ts, out
end

-- "-" means "no value" in RFC 5424 header fields.
local function nil_if_dash(v)
  if v == "-" then return nil end
  return v
end

-- Syslog from UniFi devices, already split by the unifi_syslog parser.
function device_record(tag, ts, record)
  local out = { source = "devices", timestamp = iso_from_record_time(ts), raw = record["raw"] }

  -- source_address_key gives e.g. "udp://192.168.1.1:39876"; keep the address.
  local addr = record["host"] or ""
  out.host = addr:match("^%a+://%[?([^%]]+)%]?:%d+$") or addr

  local hostname, program, message = record["hostname"], record["program"], record["message"] or ""

  -- RFC 5424: "<PRI>1 TIMESTAMP HOSTNAME APP PROCID MSGID [SD] MSG". The
  -- parser is written for RFC 3164, so split these here instead.
  local h5424, app5424, rest5424 = (record["raw"] or ""):match("^<%d+>1 %S+ (%S+) (%S+) %S+ %S+ (.*)$")
  if h5424 then
    hostname, program = nil_if_dash(h5424), nil_if_dash(app5424)
    -- Drop structured data: "-" or one or more [id key="value" ...] blocks.
    message = rest5424:gsub("^%-%s?", "", 1)
    while message:sub(1, 1) == "[" do
      local stripped = message:gsub("^%b[]", "", 1)
      if stripped == message then break end
      message = stripped
    end
    message = message:gsub("^%s+", "")

  -- Some UniFi devices send "model,mac,version" where a program name would
  -- normally go, with the real program at the start of the message.
  elseif program and program:find(",", 1, true) then
    hostname = program
    local p, rest = message:match("^([^%s:%[]+)%[?%d*%]?:%s*(.*)$")
    if p then program, message = p, rest else program = nil end
  end

  out.hostname = hostname
  out.program = program
  out.message = trim_end(message)

  local pri = tonumber(record["pri"])
  if pri then out.severity = SEVERITY[pri % 8] end
  return 2, ts, out
end
