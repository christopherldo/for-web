/**
 * Regras de qualidade da transmissão do desktop (So a Rapa).
 *
 * Este arquivo é a implementação do contrato em `soarapa-desktop/docs-stream-quality.md`.
 * Se algo aqui divergir daquele documento, o errado é o código. Os "porquês"
 * moram lá; aqui ficam só os números e a matemática.
 *
 * Vale para o caminho nativo (WGC do desktop). O caminho web continua básico,
 * usando os presets do próprio LiveKit.
 */

import type { ScreenShareQualityName } from "@revolt/state/stores/Voice";

/** Preset resolvido: o que pedir ao capturador nativo e ao encoder. */
export interface NativeQualityPlan {
  /** Altura que o preset promete — é ela que decide o tamanho (regra 4). */
  maxHeight: number;
  /** Cap de largura em 21:9; só morde além disso (regra 4). */
  maxWidth: number;
  targetFps: number;
  /** Bitrate alvo em bps, já escalado para o aspect da fonte (regras 3 e 4). */
  maxBitrate: number;
  /** Regra 2: movimento cede resolução, não framerate. */
  degradationPreference: RTCDegradationPreference;
  contentHint: "motion" | "detail" | "text";
}

/**
 * Escada de bitrate em 16:9, em bps (contrato regra 3).
 * Escolhida a escada agressiva porque o caso de uso é teamfight de LoL, onde
 * bitrate baixo vira sopa de pixels justo no momento que importa.
 */
const BASE_BITRATE: Record<string, number> = {
  low: 2_500_000, // 720p30
  low60: 4_000_000, // 720p60
  high: 6_000_000, // 1080p30
  high60: 8_000_000, // 1080p60
  text: 1_500_000, // Source 5fps — texto parado, quase sem movimento
};

/** Piso e teto do controle adaptativo (contrato regra 3). */
export const MIN_BITRATE = 1_000_000;
export const MAX_BITRATE = 12_000_000;

/** Geometria de cada preset: altura prometida e cap de largura em 21:9. */
const GEOMETRY: Record<
  string,
  { maxHeight: number; maxWidth: number; targetFps: number }
> = {
  low: { maxHeight: 720, maxWidth: 1920, targetFps: 30 },
  low60: { maxHeight: 720, maxWidth: 1920, targetFps: 60 },
  high: { maxHeight: 1080, maxWidth: 2560, targetFps: 30 },
  high60: { maxHeight: 1080, maxWidth: 2560, targetFps: 60 },
  // "Source 5FPS" é para ler texto parado: sobe o teto e desce o framerate.
  text: { maxHeight: 2160, maxWidth: 3840, targetFps: 5 },
};

/**
 * Quantos pixels o preset custa em 16:9, base para escalar o bitrate quando a
 * fonte é mais larga (regra 4: altura fixa custa ~33% mais pixels em 21:9).
 */
function baselinePixels(maxHeight: number): number {
  return Math.round((maxHeight * 16) / 9) * maxHeight;
}

/**
 * Tamanho de saída para uma fonte de `srcW`x`srcH`.
 *
 * Espelha `target_size` do `native-wgc/src/win.rs` — os dois têm que concordar,
 * senão o bitrate é calculado para uma resolução que não é a transmitida.
 */
export function targetSize(
  srcW: number,
  srcH: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

  if (srcW <= maxWidth && srcH <= maxHeight) {
    return { width: even(srcW), height: even(srcH) };
  }

  const widthAtHeight = Math.floor((srcW * maxHeight) / Math.max(1, srcH));
  if (widthAtHeight <= maxWidth) {
    return { width: even(widthAtHeight), height: even(maxHeight) };
  }

  // Além de 21:9 a largura passa a mandar: obedecer a altura deixaria o HUD
  // pequeno demais para quem assiste.
  const heightAtWidth = Math.floor((srcH * maxWidth) / Math.max(1, srcW));
  return { width: even(maxWidth), height: even(heightAtWidth) };
}

/**
 * Resolve o preset para uma fonte concreta.
 *
 * `source` é o tamanho real do que está sendo capturado. Sem ele o plano usa a
 * base 16:9 — o bitrate é corrigido assim que o primeiro frame chega e revela o
 * aspect verdadeiro.
 */
export function planFor(
  qualityName: ScreenShareQualityName,
  source?: { width: number; height: number },
): NativeQualityPlan {
  const geo = GEOMETRY[qualityName] ?? GEOMETRY.low;
  const base = BASE_BITRATE[qualityName] ?? BASE_BITRATE.low;
  const isText = qualityName === "text";

  let maxBitrate = base;
  if (source && source.width > 0 && source.height > 0) {
    const out = targetSize(
      source.width,
      source.height,
      geo.maxWidth,
      geo.maxHeight,
    );
    const ratio = (out.width * out.height) / baselinePixels(geo.maxHeight);
    maxBitrate = Math.round(base * ratio);
  }

  return {
    maxHeight: geo.maxHeight,
    maxWidth: geo.maxWidth,
    targetFps: geo.targetFps,
    maxBitrate: Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, maxBitrate)),
    // Regra 2: em movimento o framerate é informação e a nitidez é enfeite.
    // O preset de texto inverte isso de propósito.
    degradationPreference: isText
      ? "maintain-resolution"
      : "maintain-framerate",
    contentHint: isText ? "text" : "motion",
  };
}

/** O que o capturador nativo precisa saber (CaptureOptions do native-wgc). */
export function captureOptionsFor(plan: NativeQualityPlan) {
  return {
    maxWidth: plan.maxWidth,
    maxHeight: plan.maxHeight,
    targetFps: plan.targetFps,
    nv12: true,
  };
}

/**
 * Controle adaptativo de bitrate.
 *
 * Só mexe no teto de bitrate. Quem decide baixar a resolução é o próprio
 * WebRTC, via `degradationPreference: "maintain-framerate"` (regra 2) — se a
 * gente também mexesse em `scaleResolutionDownBy` os dois brigariam pelo mesmo
 * volante.
 *
 * A histerese é assimétrica de propósito: desce rápido (a stream já está ruim
 * agora) e sobe devagar (subir cedo demais só provoca a próxima queda).
 */
export class BitrateGovernor {
  private target: number;
  private readonly ceiling: number;
  private readonly startedAt: number;
  private consecutiveHealthy = 0;

  /** Degraus de 20%: perceptível o bastante para ajudar, sem pular demais. */
  private static readonly DOWN_STEP = 0.8;
  private static readonly UP_STEP = 1.25;
  /** ~3 leituras boas seguidas antes de tentar subir de novo. */
  private static readonly HEALTHY_BEFORE_UP = 3;

  /**
   * Quanto tempo ignorar `qualityLimitationReason` depois que a publicação sobe.
   *
   * O estimador de banda do WebRTC começa baixo e sobe: nos primeiros segundos
   * ele reporta `bandwidth` porque ainda não sondou a rede, não porque a rede
   * seja ruim. Reagir a isso derrubou o alvo até o piso e prendeu a
   * transmissão em 320x180 por um minuto — subindo 10% a cada 15s, ela não
   * tinha como voltar.
   */
  private static readonly WARMUP_MS = 15_000;

  constructor(plan: NativeQualityPlan) {
    this.ceiling = plan.maxBitrate;
    this.target = plan.maxBitrate;
    this.startedAt = Date.now();
  }

  /** Ainda no transiente de subida do estimador de banda. */
  private warmingUp(): boolean {
    return Date.now() - this.startedAt < BitrateGovernor.WARMUP_MS;
  }

  current(): number {
    return this.target;
  }

  /**
   * Consome uma leitura do `outbound-rtp` e devolve o novo alvo quando ele
   * mudou o bastante para valer um `setParameters`, ou `null` para não mexer.
   *
   * @param qualityLimitationReason "bandwidth" | "cpu" | "other" | "none"
   * @param availableOutgoingBitrate `available-outgoing-bitrate` do candidate-pair, quando houver
   */
  observe(
    qualityLimitationReason: string,
    availableOutgoingBitrate?: number,
  ): number | null {
    // Durante o aquecimento a leitura não diz nada sobre a rede: o estimador
    // ainda está subindo. Mexer aqui é reagir a ruído.
    if (this.warmingUp()) return null;

    const limited =
      qualityLimitationReason === "bandwidth" ||
      qualityLimitationReason === "cpu";

    let next = this.target;

    if (limited) {
      this.consecutiveHealthy = 0;
      next = this.target * BitrateGovernor.DOWN_STEP;
      // Quando a congestion control já sabe quanto cabe, confia nela em vez de
      // descer às cegas de 20% em 20%.
      if (availableOutgoingBitrate && availableOutgoingBitrate > 0) {
        next = Math.min(next, availableOutgoingBitrate * 0.9);
      }
    } else {
      this.consecutiveHealthy += 1;
      if (this.consecutiveHealthy < BitrateGovernor.HEALTHY_BEFORE_UP) {
        return null;
      }
      this.consecutiveHealthy = 0;
      if (this.target >= this.ceiling) return null;
      next = this.target * BitrateGovernor.UP_STEP;
    }

    next = Math.round(
      Math.min(
        this.ceiling,
        Math.max(MIN_BITRATE, Math.min(next, MAX_BITRATE)),
      ),
    );

    // Abaixo disso o `setParameters` custa mais do que o ajuste vale.
    if (Math.abs(next - this.target) < this.target * 0.05) return null;

    this.target = next;
    return next;
  }
}
