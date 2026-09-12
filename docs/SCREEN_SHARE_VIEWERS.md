# Contador de viewers em screen share

## Regra
Cada tile de screen share mostra quantas pessoas estão **assistindo** aquele stream (clicaram em Watch / não deram Stop Watching). O streamer **não** conta como viewer de si mesmo. O número é visível para **todo mundo** no call.

## Por quê
Alinha com o Watch / Stop Watching que já existia: o contador reflete quem de fato está puxando o vídeo, não só quem está no canal de voz.

## Como
Presença sincronizada via atributo LiveKit `soarapa.watch.<userId>=1` no participant local. Clientes somam quem tem o atributo setado para aquele streamer.
