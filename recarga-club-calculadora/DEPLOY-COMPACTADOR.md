# Deploy do compactador de video

Este site agora tem duas partes:

- `index.html`: interface do sistema.
- `video-compressor-server.js`: servidor que entrega o site e compacta videos em MP4 usando FFmpeg.
- `data/videos`: biblioteca compartilhada onde os videos compactados ficam salvos.

## Importante

Para usuarios publicos conseguirem compactar videos, nao publique apenas como site estatico.
O projeto precisa rodar como servidor Node.js com FFmpeg instalado.

Se o site for publicado apenas como HTML/CSS/JS, a tela abre normalmente, mas
o endpoint `/api/compress-video` nao existe. Nesse caso os usuarios verão erro
de "API de compactacao offline" ou "nao foi possivel compactar pelo servidor".

Para usuarios publicos baixarem os mesmos videos, a hospedagem precisa manter
um disco/pasta persistente. No Docker, a biblioteca usa `VIDEO_LIBRARY_DIR=/data/videos`.
Configure um volume/disco persistente em `/data` para nao perder os videos ao reiniciar.

## Caminho recomendado

Use o `Dockerfile` deste projeto em uma hospedagem com suporte a Docker.
Ele ja instala FFmpeg e inicia o servidor corretamente.

O comando de inicializacao e:

```bash
npm start
```

O servidor usa a porta definida pela hospedagem em `PORT`.
Se `PORT` nao existir, usa `8787`.

## Uso local

Abra:

```text
iniciar-compactador-video.bat
```

Depois acesse:

```text
http://127.0.0.1:8787
```

No uso local, o FFmpeg precisa estar instalado no Windows, ou o arquivo `ffmpeg.exe`
precisa ficar na pasta do site ou em `tools/ffmpeg.exe`.
