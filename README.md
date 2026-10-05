# ZOBO · AI agent for Zonac Knitting Production

ZOBO finds and vets Chinese machinery manufacturers, compares their products, drafts quotation emails,
and answers questions about the report, machinery, the socks industry and textile technology.

## How it is built

| Part | Where it runs | What it holds |
|---|---|---|
| This web app (`index.html`, `app.js`, `app.css`, `config.js`) | GitHub Pages, free | Code only. No data, no keys. |
| ZOBO API and agent (`Code.gs`, `AI.gs`, `Agent.gs`, `Web.gs`, `API.gs`, `Advanced.gs`) | Google Apps Script, bound to the "China Machinery Sourcing" Google Sheet | API keys (Script Properties), the pipeline, Gmail sending |
| Data | The Google Sheet | Requests, company profiles, products, evidence, quotations, users |

The browser talks directly to the Apps Script web app. Every request carries a signed session token; the API checks the user and their role on every call.

## Sign-in and roles

Users sign in with their email and a 6-digit code sent to that email (valid 10 minutes). Sessions last 7 days.
Who can sign in is set in the **Users** tab of the Sheet:

| Role | Can |
|---|---|
| Viewer | Read reports, ask ZOBO, use Industry Expert |
| Buyer | Viewer + start supplier searches, find photos, request and send quotations |
| Approver | Buyer + press Proceed (approve a shortlist) |
| Admin | Everything |

Untick **Active** to remove someone; their session stops within a minute.

## Setup (browser only)

1. Apps Script: paste the six `.gs` files, delete the old `Index` HTML file, run `authorize` once.
2. Deploy › New deployment › Web app — Execute as **Me**, Who has access **Anyone**. Copy the web app URL.
3. In this repository, edit `config.js` and paste the URL into `apiUrl`. Commit.
4. Settings › Pages › Deploy from a branch › `main` / root › Save. The app appears at `https://<account>.github.io/zobo/`.
5. Add the team in the Users tab.

After changing any `.gs` file: Deploy › Manage deployments › edit › New version (the URL stays the same).

## Deep research mode

Press **Deep research** (Assistant, Industry Expert or the report's Ask ZOBO bar), or say "deep research mode" ("डीप रिसर्च मोड चालू करो" in Hindi). Say "deep research off" to switch it off; "deep research on <topic>" researches one question deeply without switching the mode on. The choice is remembered per person on each computer.

- **Questions:** ZOBO plans the research, searches Google, Google News, Baidu and Bing China, reads the most trustworthy pages (a reader handles pages built by scripts), checks what is still missing or contradictory, searches again, then answers with numbered sources, a confidence line and the steps it took. About 1 to 3 minutes; the steps show live.
- **Supplier searches:** wider searches (trade platforms and the best-known makers checked by name), more pages read per company, up to three rounds of research for missing facts (the last one also through Google Search with Gemini), facts accepted only when the source words really say them, and two different AIs checking every fact. Each company gets a research confidence score. About 15 to 30 minutes and roughly twice the searches of a normal run.

## Limits on the free plan

- SerpApi: 250 searches a month, 50 an hour. A supplier search uses about 50 (deep research mode about 100); an Industry Expert news question up to 2, a deep question up to 10. Free backup search keys (Serper, Tavily, SearchApi.io) take over automatically when SerpApi runs out.
- Google Search through Gemini (deep research): about 500 free questions a day on Gemini 2.5 Flash.
- Gemini free tier: Google may use what is sent to improve its products. Only the machine request, public supplier information and email text are sent.
- Apps Script: emails are sent from the Google account that deployed the script (use a shared purchase account).
