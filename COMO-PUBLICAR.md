# Publicação e agenda privada

O site é servido por `server.js` no Render. O login usa os perfis existentes, sem cadastro ou convite. A agenda e os hashes legados de senha ficam em um arquivo privado, nunca no HTML ou no GitHub.

## Render

1. No serviço `site-recarga-club`, abra **Environment > Secret Files** e adicione o arquivo `recarga-agenda.json` com o conteúdo do arquivo privado gerado localmente em `data/agenda.json`.
2. Confirme que a variável `ACTIVITY_DATA_FILE` está como `/etc/secrets/recarga-agenda.json`.
3. Faça o deploy do código. Em `/health`, `activitiesReady` deve ser `true` e `activityCount` deve ser maior que zero.

O arquivo de agenda não deve ser enviado ao GitHub. Ele está excluído do Git e do contexto Docker. Para trocar a planilha futuramente, atualize o Secret File no Render e faça um novo deploy.

## Execução local

Guarde a agenda em `data/agenda.json`, execute `iniciar-servidor-recarga-club.bat` e abra `http://127.0.0.1:8787`. O HTML é servido pelo próprio processo; não use `file://` para autenticação.

No plano gratuito do Render, os serviços podem dormir por inatividade e levar um pouco para responder ao primeiro acesso. As sessões continuam válidas após o servidor acordar. Conclusões de tarefas são guardadas no navegador e não sincronizam entre dispositivos.

## Privacidade e acesso

O servidor só entrega ao usuário autenticado as tarefas atribuídas ao perfil correspondente. Os dados de contato da planilha e a chave privada de sessão permanecem no Secret File. O login continua aceitando as credenciais que já existiam no sistema; não crie contas nem envie convites.

Os dados de conclusão da planilha recebida estavam vazios. Como o backend anterior não chegou a sincronizar a agenda, não há uma lista de conclusões compartilhadas recuperável para filtrar. Conclusões já salvas localmente no navegador continuam lá; o restante aparece pendente.
