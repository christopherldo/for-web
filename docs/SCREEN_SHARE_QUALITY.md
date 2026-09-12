# Qualidade de screen share

## Por que fica borrado (PC fraco / Discord ok)
1. Presets antigos do LiveKit em **720p30 ≈ 2 Mbps** — pouco pra desktop nítido (Discord manda bem mais).
2. Codec padrão **VP8 em software** esgota CPU fraca (ex.: i5-3570S); Discord usa **H264 na GPU** (RX 550 etc.).
3. Sem `maintain-resolution`, a rede baixa a resolução e parece “tudo pixelado”.
4. Default antigo **720p60** no nosso fork — FPS alto sem bitrate/CPU suficiente = borrão.

## O que fazemos agora
- Bitrate mais alto (estilo Discord “Better”): 720p30 ≈ 4.5 Mbps, 720p60 ≈ 6, 1080p30 ≈ 8, 1080p60 ≈ 10.
- Codec preferido **H264** + `degradationPreference: maintain-resolution`.
- Sem simulcast no share (bitrate concentrado numa camada).
- `contentHint: detail` nos presets 30 FPS (texto/UI mais nítido); `motion` nos 60 FPS.
- Default de qualidade: **720p30** (não mais 60).

## Dica pro pessoal em PC fraco
- Usar **720p 30** (ou Source 5FPS se for só texto).
- Manter **aceleração por hardware ligada** no app desktop.
- App desktop (Electron) costuma se sair melhor que Chrome puro no encode.
