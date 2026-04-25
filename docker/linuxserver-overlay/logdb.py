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
    conn.commit()
    return conn


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
          game_name, game_file, console, console_title, emulator, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      where.append("(title LIKE ? OR username LIKE ? OR ip LIKE ? OR game_name LIKE ? OR console LIKE ? OR event_type LIKE ?)")
      needle = f"%{search}%"
      params.extend([needle, needle, needle, needle, needle, needle])

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
               host, game_name, game_file, console, console_title, emulator, details_json
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


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"status": "error", "message": "Usage: logdb.py <write|query> <db_path>"}))
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
