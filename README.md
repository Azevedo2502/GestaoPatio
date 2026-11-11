# Gestão Pátio

Aplicação web para acompanhar a fila contínua dos mecânicos e administrar os veículos da oficina. A interface é estática; autenticação, dados persistentes, autorização no banco e sincronização em tempo real são fornecidos pelo Supabase.

## Preparar o Supabase

1. Crie um projeto no [Supabase](https://supabase.com/). O plano gratuito atende a um uso inicial, sujeito aos limites e alterações de plano do fornecedor.
2. No **SQL Editor**, execute todo o arquivo `supabase-schema.sql`.
   Se o projeto já estiver em uso, execute também `fix-add-mechanic.sql` para habilitar o cadastro de mecânicos, garantir as colunas de placa, atualizar a função que grava a placa no início do serviço e recarregar o cache do Supabase.
   Se a confirmação diária de abertura falhar com `UPDATE requires a WHERE clause`, execute também `fix-open-workday.sql` no SQL Editor.
   Se a reorganização da fila falhar com essa mesma mensagem, execute também `fix-reorder-mechanics.sql`.
3. Em **Project Settings → API**, copie a Project URL e a chave **publishable** (ou anon legada) para `supabase-config.js`. Nunca use `service_role`/secret key no navegador.
4. Em **Authentication → Providers**, mantenha habilitado e-mail/senha. Desabilite o cadastro público de usuários.
5. Crie quatro usuários em **Authentication → Users → Add user → Create new user**, definindo uma senha forte para cada conta e marcando **Auto Confirm User** (ou confirmando manualmente cada usuário no painel). Como esses endereços não recebem mensagens, a conta precisa ser confirmada pelo administrador do projeto. Embora o painel peça um e-mail, os administradores entrarão no Gestão Pátio apenas com o nome de usuário. Use estes identificadores internos:

   | Administrador | E-mail interno no Supabase | Usuário digitado no sistema |
   | --- | --- | --- |
   | Caio | `caio@usuarios.gestaopatio.invalid` | `caio` |
   | Gustavo | `gustavo@usuarios.gestaopatio.invalid` | `gustavo` |
   | Fernando | `fernando@usuarios.gestaopatio.invalid` | `fernando` |
   | Victor | `victor@usuarios.gestaopatio.invalid` | `victor` |

   O sufixo `.invalid` é reservado para endereços que não devem receber e-mail; essas contas usam senha gerenciada pelo responsável no Supabase. Não reutilize senhas pessoais.
6. Depois de criar as quatro contas, copie os IDs de usuário em **Authentication → Users** e execute no SQL Editor, substituindo IDs:

   ```sql
   insert into public.admin_users (user_id, display_name) values
     ('UUID-DO-CAIO', 'Caio'),
     ('UUID-DO-GUSTAVO', 'Gustavo'),
     ('UUID-DO-FERNANDO', 'Fernando'),
     ('UUID-DO-VICTOR', 'Victor');
   ```

   As senhas são definidas individualmente no Supabase Auth; não há senha administrativa embutida no código.
7. Abra `index.html` por um servidor local ou publique os arquivos `index.html`, `app.js`, `styles.css`, `supabase-config.js` e a pasta `assets` juntos. O logo STAR com fundo transparente está em `assets/star-logo.png`. `patio.html` redireciona para a página principal.

## Publicar com Cloudflare Pages

1. Crie um repositório GitHub e envie os arquivos do projeto, incluindo `supabase-schema.sql` e este README.
2. Em Cloudflare Pages, conecte o repositório. Como é um site estático, deixe o comando de build vazio e use a raiz do projeto como diretório de saída.
3. Após o deploy, cadastre o domínio do site em **Authentication → URL Configuration** do Supabase, incluindo a URL de produção e a URL local de desenvolvimento em *Redirect URLs*.
4. Distribua o endereço público aos mecânicos. Eles podem apenas visualizar; somente contas incluídas em `admin_users` conseguem administrar.

## Regras implementadas

- Fila inicial: Yago, Vitor, Rodrigo e José. A ordem persiste e não é reiniciada por data.
- O expediente só libera operações após o gerente confirmar a presença diária. Presente mantém a ordem; atrasado e ausente vão ao final, preservando a ordem relativa entre eles. A data usa `America/Sao_Paulo`; não existe abertura automática nem histórico individual de atrasos.
- Finalizar serviço libera o mecânico e o move para o fim da fila. Mudança manual para disponível não conta como serviço finalizado.
- Entrada de veículos e finalizações são contadas separadamente por dia; a fila não é afetada pela virada do dia.
- Todas as operações administrativas são funções transacionais protegidas por autenticação e validam permissões no banco. A fila é serializada por lock para evitar alterações concorrentes.
- O painel público recebe mudanças de fila e contadores em tempo real. Nenhuma senha ou chave privada fica no navegador.
- A realocação manual da fila atualiza a tela de forma otimista, anima a movimentação e mantém os controles editados no lugar enquanto salva no banco.
- O botão de tela cheia usa o recurso do navegador; a barra de endereço só desaparece após um clique do usuário, e o modo pode ser encerrado pelo botão ou pelo próprio navegador.

## Observações

O projeto Supabase já está configurado neste workspace e o esquema e os quatro mecânicos iniciais foram confirmados. O login administrativo depende de criar as quatro contas e associar seus IDs à tabela `admin_users`. A publicação no GitHub/Cloudflare Pages ainda precisa ser feita na conta do responsável. O plano gratuito tem cotas e políticas de pausa/limites que podem mudar; confirme as condições vigentes do provedor.
