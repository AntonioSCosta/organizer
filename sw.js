// =====================================================================
// Service worker da Plataforma pessoal
// =====================================================================
// Faz duas coisas, e convém perceber a diferença:
//
//   1. Guarda a CASCA da app (o HTML, o manifesto, os ícones). É isto que
//      permite abrir a app sem rede e ver alguma coisa em vez de um dinossauro.
//   2. Guarda a ÚLTIMA RESPOSTA da tua Apps Script. Quando não há rede, serve
//      essa — mas marca-a, para a página te poder dizer que estás a ver dados
//      velhos. Dados velhos sem aviso são piores do que nenhuns dados: leem-se
//      como se fossem de agora.
//
// O que NUNCA é guardado: os POST. Escrever precisa de rede, ponto. Fingir que
// uma escrita passou quando não passou seria mentir-te sobre a tua Sheet.

const VERSAO = "v3";
const CASCA = "casca-" + VERSAO;
const DADOS = "dados-" + VERSAO;

const FICHEIROS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icone-192.png",
  "./icone-512.png",
  "./icone-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches
      .open(CASCA)
      .then((c) => c.addAll(FICHEIROS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((nomes) =>
        Promise.all(
          nomes
            .filter((n) => n !== CASCA && n !== DADOS)
            .map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Marca uma resposta guardada como sendo do arquivo, e diz de QUANDO é.
//
// O carimbo vai dentro do JSON e não num cabeçalho, e isso foi aprendido à
// força: um cabeçalho próprio numa resposta a um pedido de outra origem é
// apagado pelo filtro de CORS antes de chegar à página, mesmo tendo sido o
// service worker a criá-la. Testei, e chegava lá sempre vazio.
//
// Ir pelo corpo resolveu isso e ainda corrigiu um erro meu: a barra dizia a
// hora a que a abrias, não a hora a que os dados foram apanhados. Agora diz a
// verdade, porque a hora é guardada no momento em que a resposta é arquivada.
async function comCarimbo(resposta) {
  const em = resposta.headers.get("X-Guardado-Em") || "";
  let texto = await resposta.text();
  try {
    const obj = JSON.parse(texto);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      obj._arquivo = { em: em };
      texto = JSON.stringify(obj);
    }
  } catch (e) {
    // Não era JSON. Devolve-se tal e qual — melhor do que estragar.
  }
  return new Response(texto, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Guarda a resposta com a hora a que foi guardada agarrada a ela. Este
// cabeçalho nunca chega à página: serve só para o arquivo saber a sua idade.
async function arquivar(req, resposta) {
  const corpo = await resposta.blob();
  const cabecalhos = new Headers(resposta.headers);
  cabecalhos.set("X-Guardado-Em", new Date().toISOString());
  const c = await caches.open(DADOS);
  await c.put(req.url, new Response(corpo, { status: 200, headers: cabecalhos }));
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);

  // Escritas: só rede. Sem rede, falha — e a página já sabe dizê-lo.
  if (req.method !== "GET") return;

  // Tudo o que vem de fora desta origem são os dados: a tua Apps Script e o
  // serviço do tempo. Primeiro a rede; o arquivo só quando ela falta.
  //
  // Reparar que a regra é "de outra origem" e não "de script.google.com".
  // Escrevi-a primeiro com o nome do domínio lá dentro e não havia maneira
  // honesta de a testar — qualquer teste teria de fingir ser a Google. Assim
  // basta apontar a app a outro servidor para o comportamento ser o mesmo, o
  // que quer dizer que o que eu testo é mesmo o que tu vais correr.
  if (url.origin !== self.location.origin) {
    ev.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res && res.ok && res.type !== "opaque") {
            arquivar(req, res.clone());
            return res;
          }
          // Uma resposta com erro conta como falha, não como resposta. Isto
          // não estava assim no início e estava mal: se a Apps Script
          // devolvesse um 500, a app engolia-o e mostrava-te uma página vazia,
          // em vez de te mostrar o que tinha guardado e dizer que era velho.
          const guardado = await caches.match(req.url);
          return guardado ? comCarimbo(guardado) : res;
        })
        .catch(async () => {
          const guardado = await caches.match(req.url);
          if (guardado) return comCarimbo(guardado);
          return new Response(JSON.stringify({ erro: "sem rede e sem arquivo" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // A PÁGINA: primeiro a rede, e o arquivo só se ela faltar.
  //
  // Isto começou ao contrário — arquivo primeiro, rede por trás a atualizar em
  // silêncio — e o resultado era mau de uma maneira difícil de diagnosticar:
  // depois de eu publicar uma versão nova, a primeira abertura da app servia
  // na mesma a página velha, e a nova só aparecia à SEGUNDA. Deu-se o caso de
  // uma secção nova existir no computador e não no telemóvel, e parecer um
  // problema de tamanho de ecrã quando era só uma cópia em cache.
  //
  // Com a rede à frente, estando online tens sempre a última; estando offline
  // tens a guardada, que é para isso que ela serve.
  const ehPagina =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").indexOf("text/html") !== -1;

  if (ehPagina) {
    ev.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copia = res.clone();
            caches.open(CASCA).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (guardado) {
            return guardado || caches.match("./index.html");
          });
        }),
    );
    return;
  }

  // O resto da casca (ícones, manifesto) não muda quase nunca: arquivo
  // primeiro, e a rede por trás a atualizá-lo em silêncio.
  ev.respondWith(
    caches.match(req).then((guardado) => {
      const daRede = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copia = res.clone();
            caches.open(CASCA).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(() => guardado);
      return guardado || daRede;
    }),
  );
});
