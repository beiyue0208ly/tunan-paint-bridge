<template>
  <span class="stop-spinner" aria-hidden="true">
    <span class="stop-spinner__base"></span>
    <span class="stop-spinner__ring"></span>
    <span class="stop-spinner__core"></span>
  </span>
</template>

<style scoped>
.stop-spinner {
  position: relative;
  display: block;
  width: 16px;
  height: 16px;
}

.stop-spinner__base {
  position: absolute;
  inset: 1px;
  border-radius: 999px;
  background: radial-gradient(
    circle at 50% 50%,
    rgba(226, 238, 255, 0.12) 0%,
    rgba(226, 238, 255, 0.06) 52%,
    rgba(226, 238, 255, 0.02) 100%
  );
  box-shadow: inset 0 0 0 1px rgba(226, 238, 255, 0.08);
}

.stop-spinner__ring {
  position: absolute;
  inset: 0;
  display: block;
  border-radius: 999px;
  border: 2px solid rgba(226, 238, 255, 0.16);
  border-color: rgba(226, 238, 255, 0.28);
  box-shadow:
    inset 0 0 0 1px rgba(226, 238, 255, 0.04),
    0 0 8px rgba(182, 212, 255, 0.06);
  animation: stop-ring-breathe 1.9s ease-in-out infinite;
  will-change: opacity, transform, box-shadow;
}

.stop-spinner__core {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  border-radius: 2.2px;
  background: rgba(234, 242, 255, 0.9);
  transform: translate(-50%, -50%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    0 0 6px rgba(182, 212, 255, 0.1);
  animation: stop-core-breathe 1.9s ease-in-out infinite;
  will-change: transform, opacity;
}

@keyframes stop-ring-breathe {
  0%,
  100% {
    transform: scale(0.97);
    opacity: 0.72;
    box-shadow:
      inset 0 0 0 1px rgba(226, 238, 255, 0.04),
      0 0 6px rgba(182, 212, 255, 0.04);
  }
  50% {
    transform: scale(1);
    opacity: 0.9;
    box-shadow:
      inset 0 0 0 1px rgba(226, 238, 255, 0.08),
      0 0 10px rgba(182, 212, 255, 0.08);
  }
}

@keyframes stop-core-breathe {
  0%,
  100% {
    transform: translate(-50%, -50%) scale(0.92);
    opacity: 0.9;
  }
  50% {
    transform: translate(-50%, -50%) scale(1.04);
    opacity: 1;
  }
}
</style>
