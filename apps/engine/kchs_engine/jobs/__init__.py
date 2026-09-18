"""Обработчики заданий движка."""

from kchs_engine.jobs.registry import JOB_HANDLERS, handler, registered_queues

__all__ = ["JOB_HANDLERS", "handler", "registered_queues"]
