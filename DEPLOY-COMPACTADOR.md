# Deploy do compactador de video

Este site agora tem duas partes:

- `index.html`: interface do sistema.
- `video-compressor-server.js`: servidor que entrega o site e compacta videos em MP4 usando FFmpeg.
- Supabase Storage: biblioteca compartilhada onde os videos compactados ficam salvos em producao.
- `data/videos`: fallback local para testes quando Supabase nao estiver configurado.

## Importante

Para usuarios publicos conseguirem compactar videos, nao publique apenas como site estatico.
O projeto precisa rodar como servidor Node.js com FFmpeg instalado.

Se o site for publicado apenas como HTML/CSS/JS, a tela abre normalmente, mas
o endpoint `/api/compress-video` nao existe. Nesse caso os usuarios verão erro
de "API de compactacao offline" ou "nao foi possivel compactar pelo servidor".

Para usuarios publicos baixarem os mesmos videos sem perder arquivos em reinicio,
configure Supabase Storage no Render com estas variaveis:

```text
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
SUPABASE_BUCKET=videos
```

Nao coloque a chave `SUPABASE_SERVICE_ROLE_KEY` no GitHub. Ela deve ficar somente
nas variaveis de ambiente do Render.

Se Supabase nao estiver configurado, o servidor usa a pasta local `data/videos`
apenas como fallback de teste.

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
