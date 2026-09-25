"""Трассы движка (ADR-0167): спан задания продолжает трассу api; без адреса коллектора
трассы выключены и OpenTelemetry не нужен."""

import json
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from kchs_engine import telemetry

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN = "00f067aa0ba902b7"
TRACEPARENT = f"00-{TRACE_ID}-{PARENT_SPAN}-01"


@pytest.fixture
def exporter() -> Iterator[InMemorySpanExporter]:
    spans = InMemorySpanExporter()
    telemetry.reset_tracing()
    telemetry.configure_tracing(FastAPI(), exporter=spans)
    yield spans
    telemetry.reset_tracing()


def test_job_span_continues_api_trace(exporter: InMemorySpanExporter) -> None:
    # BullMQ хранит telemetry.metadata задания под ключом `tm`
    opts = {"attempts": 3, "tm": json.dumps({"traceparent": TRACEPARENT})}
    with telemetry.job_span("transform", "demo.generate", "job-1", 1, opts):
        pass

    [span] = exporter.get_finished_spans()
    assert span.name == "job transform demo.generate"
    assert format(span.context.trace_id, "032x") == TRACE_ID
    assert span.parent is not None
    assert format(span.parent.span_id, "016x") == PARENT_SPAN
    assert span.attributes is not None
    assert span.attributes["messaging.destination.name"] == "transform"
    assert span.attributes["messaging.message.id"] == "job-1"


def test_job_span_reads_uncompressed_telemetry(exporter: InMemorySpanExporter) -> None:
    opts = {"telemetry": {"metadata": json.dumps({"traceparent": TRACEPARENT})}}
    with telemetry.job_span("files", "preview", "job-2", 2, opts):
        pass

    [span] = exporter.get_finished_spans()
    assert format(span.context.trace_id, "032x") == TRACE_ID


def test_job_span_new_trace_and_error(exporter: InMemorySpanExporter) -> None:
    opts = {"tm": "не json"}
    with pytest.raises(RuntimeError), telemetry.job_span("import", "dataset", "job-3", 1, opts):
        raise RuntimeError("сбой")

    [span] = exporter.get_finished_spans()
    assert span.parent is None
    assert span.status.status_code.name == "ERROR"


def test_disabled_without_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    telemetry.reset_tracing()
    telemetry.configure_tracing(FastAPI())

    assert not telemetry.tracing_enabled()
    with telemetry.job_span("echo", "ping", "job-4", 1, None):
        pass
