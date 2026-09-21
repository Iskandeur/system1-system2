FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    KEV_DTYPE=float32

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# CPU-only torch.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

# What kev.serve needs. (Kev's full training deps are heavier; keep the server image minimal.)
RUN pip install --no-cache-dir fastapi uvicorn "transformers>=5.17,<6" safetensors huggingface_hub numpy typesafe-sdk accelerate \
    peft datasets scikit-learn

# Kev repo: upstream's packaging is currently not pip-installable due to multiple top-level
# packages in a flat layout, so we run it from a git checkout.
RUN git clone --depth 1 https://github.com/jaredpalmer/kev.git /opt/kev
ENV PYTHONPATH=/opt/kev

EXPOSE 8009
CMD ["python", "-m", "kev.serve", "--run", "jaredpalmer/kev-0.8b", "--port", "8009"]
