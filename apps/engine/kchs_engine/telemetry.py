"""Трассы движка (ADR-0167): OTLP/HTTP в тот же коллектор, что у api (ADR-0045).

Без OTEL_EXPORTER_OTLP_ENDPOINT трассы выключены полностью — пакеты OpenTelemetry даже
не импортируются. Спаны: входящие запросы FastAPI (кроме /health), исходящие запросы
httpx — обратные вызовы в api уносят контекст в заголовке traceparent, — и задания
очередей. Родитель задания — контекст, который api положил при постановке
(`JobService.schedule`): BullMQ хранит его в опциях задания под ключом `tm`.
"""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from kchs_engine import __version__

_tracer: Any = None


def tracing_enabled() -> bool:
    return bool(os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip())


def configure_tracing(app: Any, exporter: Any = None) -> None:
    """Включает трассы, если задан адрес коллектора; `exporter` — для тестов."""
    global _tracer
    if _tracer is not None or (exporter is None and not tracing_enabled()):
        return

    from opentelemetry import trace
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor

    attributes: dict[str, str] = {"service.version": __version__}
    # OTEL_SERVICE_NAME, если задан, SDK берёт сам
    if not os.environ.get("OTEL_SERVICE_NAME"):
        attributes["service.name"] = "kchs-engine"
    # Сэмплер — из OTEL_TRACES_SAMPLER и OTEL_TRACES_SAMPLER_ARG, как у api
    provider = TracerProvider(resource=Resource.create(attributes))
    if exporter is None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    else:
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, excluded_urls="health")
    HTTPXClientInstrumentor().instrument(tracer_provider=provider)
    _tracer = provider.get_tracer("kchs-engine", __version__)


def _parent_metadata(opts: dict[str, Any] | None) -> str | None:
    """W3C traceparent задания: BullMQ сжимает `telemetry.metadata` в `tm`."""
    opts = opts or {}
    metadata = opts.get("tm")
    if metadata is None:
        telemetry = opts.get("telemetry")
        metadata = telemetry.get("metadata") if isinstance(telemetry, dict) else None
    return metadata if isinstance(metadata, str) else None


@contextmanager
def job_span(
    queue: str, name: str, job_id: str, attempt: int, opts: dict[str, Any] | None
) -> Iterator[None]:
    """Спан задания — как у TypeScript-воркера (`job <очередь> <имя>`, messaging.*)."""
    if _tracer is None:
        yield
        return

    from opentelemetry.trace import SpanKind
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    parent = None
    metadata = _parent_metadata(opts)
    if metadata:
        try:
            carrier = json.loads(metadata)
            if isinstance(carrier, dict):
                parent = TraceContextTextMapPropagator().extract(carrier)
        except ValueError:
            parent = None

    with _tracer.start_as_current_span(
        f"job {queue} {name}",
        context=parent,
        kind=SpanKind.CONSUMER,
        attributes={
            "messaging.system": "bullmq",
            "messaging.operation.type": "process",
            "messaging.destination.name": queue,
            "messaging.message.id": job_id,
            "kchs.job.name": name,
            "kchs.job.attempt": attempt,
        },
    ):
        yield


def reset_tracing() -> None:
    """Сброс для тестов: следующий `configure_tracing` настроит заново."""
    global _tracer
    _tracer = None
