# registry.access.redhat.com/ubi9/python-312-minimal:latest (UBI 9.8, Python 3.12), multi-arch index digest
FROM registry.access.redhat.com/ubi9/python-312-minimal@sha256:8d9955078019f81659230b378bf916da4cd63ccc82f7f88a40ab642730cb776f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY app /app
USER 0
RUN mkdir /state && chown 65534:65534 /state
USER 65534:65534
LABEL org.opencontainers.image.source=https://github.com/djlongy/registry-lite-ui
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["python", "-c", "import os, ssl, urllib.request as u; u.urlopen(('https' if os.environ.get('UI_TLS_CERT') else 'http') + '://127.0.0.1:8080/healthz', timeout=2, context=ssl._create_unverified_context())"]
CMD ["python", "/app/server.py"]
