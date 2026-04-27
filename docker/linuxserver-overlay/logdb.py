#!/usr/bin/env python3
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def ensure_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          event_type TEXT,
          action TEXT,
          status TEXT,
          title TEXT,
          username TEXT,
          role TEXT,
          source TEXT,
          ip TEXT,
          forwarded_for TEXT,
          user_agent TEXT,
          host TEXT,
          origin TEXT,
          referer TEXT,
          request_path TEXT,
          game_name TEXT,
          game_file TEXT,
          console TEXT,
          console_title TEXT,
          emulator TEXT,
          details_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_username ON events(username)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scan_id TEXT,
          timestamp TEXT NOT NULL,
          ended_at TEXT,
          scan_type TEXT,
          label TEXT,
          target TEXT,
          mode TEXT,
          status TEXT,
          total_items INTEGER,
          processed_items INTEGER,
          new_items INTEGER,
          changed_items INTEGER,
          skipped_items INTEGER,
          downloaded_items INTEGER,
          failed_items INTEGER,
          result_json TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scan_runs_timestamp ON scan_runs(timestamp DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scan_runs_type ON scan_runs(scan_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status)")
    ensure_column(conn, "events", "geo_summary", "TEXT")
    ensure_column(conn, "events", "geo_country", "TEXT")
    ensure_column(conn, "events", "geo_region", "TEXT")
    ensure_column(conn, "events", "geo_city", "TEXT")
    ensure_column(conn, "events", "geo_postal_code", "TEXT")
    ensure_column(conn, "events", "geo_timezone", "TEXT")
    conn.commit()
    return conn


def ensure_column(conn: sqlite3.Connection, table: str, column: str, column_type: str) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_event(conn: sqlite3.Connection, payload: dict) -> dict:
    retention_days = int(payload.get("retentionDays") or 90)
    entry = payload.get("entry") or {}
    game = entry.get("game") or {}
    timestamp = entry.get("time") or utc_now_iso()
    conn.execute(
        """
        INSERT INTO events (
          timestamp, event_type, action, status, title, username, role, source, ip,
          forwarded_for, user_agent, host, origin, referer, request_path,
          game_name, game_file, console, console_title, emulator, details_json,
          geo_summary, geo_country, geo_region, geo_city, geo_postal_code, geo_timezone
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            timestamp,
            entry.get("event", ""),
            entry.get("action", ""),
            entry.get("status", ""),
            entry.get("title", ""),
            entry.get("username", ""),
            entry.get("role", ""),
            entry.get("source", ""),
            entry.get("ip", ""),
            entry.get("forwardedFor", ""),
            entry.get("userAgent", ""),
            entry.get("host", ""),
            entry.get("origin", ""),
            entry.get("referer", ""),
            entry.get("requestPath", ""),
            game.get("name", ""),
            game.get("file", ""),
            game.get("console", ""),
            game.get("consoleTitle", ""),
            game.get("emulator", ""),
            json.dumps(entry, ensure_ascii=True, sort_keys=True),
            entry.get("geoSummary", ""),
            entry.get("geoCountry", ""),
            entry.get("geoRegion", ""),
            entry.get("geoCity", ""),
            entry.get("geoPostalCode", ""),
            entry.get("geoTimezone", ""),
        ),
    )
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).replace(microsecond=0).isoformat()
    conn.execute("DELETE FROM events WHERE timestamp < ?", (cutoff,))
    conn.commit()
    return {"status": "success"}


def query_events(conn: sqlite3.Connection, payload: dict) -> dict:
    filters = payload.get("filters") or {}
    limit = max(1, min(int(filters.get("limit") or 200), 1000))
    where = []
    params = []

    event_type = str(filters.get("eventType") or "").strip()
    if event_type and event_type != "all":
      where.append("event_type = ?")
      params.append(event_type)

    status = str(filters.get("status") or "").strip()
    if status and status != "all":
      where.append("status = ?")
      params.append(status)

    username = str(filters.get("username") or "").strip()
    if username:
      where.append("username LIKE ?")
      params.append(f"%{username}%")

    search = str(filters.get("search") or "").strip()
    if search:
      where.append("(title LIKE ? OR username LIKE ? OR ip LIKE ? OR game_name LIKE ? OR console LIKE ? OR event_type LIKE ? OR geo_summary LIKE ? OR geo_city LIKE ? OR geo_region LIKE ? OR geo_country LIKE ?)")
      needle = f"%{search}%"
      params.extend([needle, needle, needle, needle, needle, needle, needle, needle, needle, needle])

    since_days = filters.get("sinceDays")
    if since_days not in (None, "", "all"):
      try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=int(since_days))).replace(microsecond=0).isoformat()
        where.append("timestamp >= ?")
        params.append(cutoff)
      except Exception:
        pass

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute("SELECT COUNT(*) FROM events" + where_sql, params).fetchone()[0]
    rows = conn.execute(
        """
        SELECT id, timestamp, event_type, action, status, title, username, role, source, ip,
               host, game_name, game_file, console, console_title, emulator, details_json,
               geo_summary, geo_country, geo_region, geo_city, geo_postal_code, geo_timezone
        FROM events
        """
        + where_sql
        + " ORDER BY timestamp DESC LIMIT ?",
        [*params, limit],
    ).fetchall()

    events = []
    for row in rows:
        item = dict(row)
        try:
            item["details"] = json.loads(item.pop("details_json"))
        except Exception:
            item["details"] = {}
            item.pop("details_json", None)
        events.append(item)
    return {"status": "success", "total": total, "events": events}


def write_scan(conn: sqlite3.Connection, payload: dict) -> dict:
    retention_days = int(payload.get("retentionDays") or 90)
    entry = payload.get("entry") or {}
    scan = entry.get("scan") or {}
    timestamp = entry.get("time") or scan.get("startedAt") or utc_now_iso()
    conn.execute(
        """
        INSERT INTO scan_runs (
          scan_id, timestamp, ended_at, scan_type, label, target, mode, status,
          total_items, processed_items, new_items, changed_items, skipped_items,
          downloaded_items, failed_items, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            scan.get("id", ""),
            timestamp,
            scan.get("endedAt", ""),
            scan.get("type", ""),
            scan.get("label", ""),
            scan.get("target", ""),
            scan.get("mode", ""),
            scan.get("status", ""),
            int(scan.get("totalItems") or 0),
            int(scan.get("processedItems") or 0),
            int(scan.get("newItems") or 0),
            int(scan.get("changedItems") or 0),
            int(scan.get("skippedItems") or 0),
            int(scan.get("downloadedItems") or 0),
            int(scan.get("failedItems") or 0),
            json.dumps(entry, ensure_ascii=True, sort_keys=True),
        ),
    )
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).replace(microsecond=0).isoformat()
    conn.execute("DELETE FROM scan_runs WHERE timestamp < ?", (cutoff,))
    conn.commit()
    return {"status": "success"}


def query_scans(conn: sqlite3.Connection, payload: dict) -> dict:
    filters = payload.get("filters") or {}
    limit = max(1, min(int(filters.get("limit") or 200), 1000))
    where = []
    params = []

    scan_type = str(filters.get("scanType") or "").strip()
    if scan_type and scan_type != "all":
        where.append("scan_type = ?")
        params.append(scan_type)

    status = str(filters.get("status") or "").strip()
    if status and status != "all":
        where.append("status = ?")
        params.append(status)

    target = str(filters.get("target") or "").strip()
    if target:
        where.append("target LIKE ?")
        params.append(f"%{target}%")

    since_days = filters.get("sinceDays")
    if since_days not in (None, "", "all"):
        try:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=int(since_days))).replace(microsecond=0).isoformat()
            where.append("timestamp >= ?")
            params.append(cutoff)
        except Exception:
            pass

    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    total = conn.execute("SELECT COUNT(*) FROM scan_runs" + where_sql, params).fetchone()[0]
    rows = conn.execute(
        """
        SELECT id, scan_id, timestamp, ended_at, scan_type, label, target, mode, status,
               total_items, processed_items, new_items, changed_items, skipped_items,
               downloaded_items, failed_items, result_json
        FROM scan_runs
        """
        + where_sql
        + " ORDER BY timestamp DESC LIMIT ?",
        [*params, limit],
    ).fetchall()

    scans = []
    for row in rows:
        item = dict(row)
        try:
            item["details"] = json.loads(item.pop("result_json"))
        except Exception:
            item["details"] = {}
            item.pop("result_json", None)
        scans.append(item)
    return {"status": "success", "total": total, "scans": scans}


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"status": "error", "message": "Usage: logdb.py <write|query|write-scan|query-scans> <db_path>"}))
        return 1
    command = sys.argv[1]
    db_path = Path(sys.argv[2])
    payload = {}
    raw = sys.stdin.read().strip()
    if raw:
        payload = json.loads(raw)
    conn = ensure_db(db_path)
    try:
        if command == "write":
            result = write_event(conn, payload)
        elif command == "query":
            result = query_events(conn, payload)
        elif command == "write-scan":
            result = write_scan(conn, payload)
        elif command == "query-scans":
            result = query_scans(conn, payload)
        else:
            result = {"status": "error", "message": "Unknown command"}
            print(json.dumps(result))
            return 1
        print(json.dumps(result))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
