"""
db.py — process-wide PostgreSQL connection pools.

B9: every query previously opened a fresh connection with psycopg2.connect and
closed it *outside* a try/finally, so any exception mid-query leaked the socket
until garbage collection. A single /search request opened three or more
connections, and under concurrency this exhausted max_connections.

Pools are cheap to hold and remove the per-request TCP handshake plus
authentication round trip (roughly 15-30 ms each) from the hot path.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

from config import GOLDEN_DB, VECTOR_DB

logger = logging.getLogger(__name__)

_vector_pool: ThreadedConnectionPool | None = None
_golden_pool: ThreadedConnectionPool | None = None


def _get_vector_pool() -> ThreadedConnectionPool:
    global _vector_pool
    if _vector_pool is None:
        _vector_pool = ThreadedConnectionPool(minconn=1, maxconn=10, **VECTOR_DB)
    return _vector_pool


def _get_golden_pool() -> ThreadedConnectionPool:
    global _golden_pool
    if _golden_pool is None:
        _golden_pool = ThreadedConnectionPool(minconn=1, maxconn=10, **GOLDEN_DB)
    return _golden_pool


@contextmanager
def vector_cursor() -> Iterator[psycopg2.extras.RealDictCursor]:
    """Cursor on the vector DB. The connection is always returned to the pool."""
    pool = _get_vector_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


@contextmanager
def golden_cursor() -> Iterator[psycopg2.extras.RealDictCursor]:
    """
    Cursor on the golden DB.

    The session is marked read-only at the connection level, which enforces the
    "never written to" contract in the module docstrings rather than relying on
    every call site to honour it.
    """
    pool = _get_golden_pool()
    conn = pool.getconn()
    try:
        conn.set_session(readonly=True)
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
    finally:
        pool.putconn(conn)


def close_pools() -> None:
    """Closes both pools. Called from the FastAPI lifespan shutdown hook."""
    global _vector_pool, _golden_pool
    for name, pool in (("vector", _vector_pool), ("golden", _golden_pool)):
        if pool is not None:
            try:
                pool.closeall()
            except Exception as exc:  # noqa: BLE001 - shutdown must not raise
                logger.warning("Failed closing %s pool: %s", name, exc)
    _vector_pool = None
    _golden_pool = None
