FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# CPU-only stack.
# We install torch from the official CPU wheel index to avoid pulling CUDA runtime wheels.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch
RUN pip install --no-cache-dir fastapi uvicorn transformers safetensors huggingface_hub numpy
RUN pip install --no-cache-dir --no-deps laya

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8010
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8010"]
