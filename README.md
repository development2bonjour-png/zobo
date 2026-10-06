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

There are two ways to sign in. Both give the same signed session, which lasts 7 days.

- **Sign in with Google.** Anybody with a Google account can press the button.
  - The script checks Google's ID token itself, through Google's `tokeninfo`. It checks:
    - the audience is this app's client ID;
    - the issuer is Google;
    - the token has not expired;
    - the email is verified;
    - a one-time nonce issued by the script is present (used once, valid 15 minutes).
  - The Google account ID is linked to the person's row, so another Google account with the same address is refused.
  - A person not yet in the Users tab is added as **Waiting for approval**. The admins get an email and approve or refuse on the **People** page.
  - Optional (ZOBO › Set up Google sign-in):
    - new people get Viewer at once;
    - new people get Buyer at once, which needs a company email domain;
    - only some email domains may ask for access.
  - Google vouches for an address only for Gmail and Google Workspace domains. Any other address must prove the mailbox once with an emailed code before its Google account is linked, and is never let in automatically.
- **Emailed code.** Type the email and get a 6-digit code (valid 10 minutes).

Who may use ZOBO is set in the **Users** tab of the Sheet (Email | Name | Role | Active | Added on | Last sign-in | Google ID | Note). Admins can also manage it on the **People** page of the app.

| Role | Can |
|---|---|
| Viewer | Assistant, My results, Expert and Cart with the separate viewer AI; no company data |
| Buyer | Viewer + start supplier searches, find photos, request and send quotations |
| Approver | Buyer + press Proceed (approve a shortlist) |
| Admin | Everything |

Untick **Active** to remove someone; their session stops within a minute.

### Switching on Google sign-in (free, browser only, once)

1. Go to console.cloud.google.com and sign in with the Google account that owns the Sheet. Create a project, for example "ZOBO".
2. Open **Google Auth Platform** (older screens: APIs & Services › OAuth consent screen) › Get started.
   - Enter the app name ZOBO and your email, choose the audience **External**, and finish.
   - Under Audience, press **Publish app**, so that every Google account can sign in, not only test users.
   - ZOBO asks only for the basic sign-in details (email, name), which need no Google review.
3. Open **Clients** › Create client (older screens: Credentials › Create credentials › OAuth client ID) › Application type **Web application**.
   - Under Authorised JavaScript origins, add `https://<account>.github.io`. Use no path and no slash at the end.
   - Press Create, then copy the Client ID (it ends in `.apps.googleusercontent.com`).
4. In the Sheet, open ZOBO › Set up Google sign-in, paste the Client ID, and choose the rule for new people.

The Client ID is public, so it is not a secret. No data leaves Google: the Sheet stays the only database.

## Setup (browser only)

1. Apps Script: paste the six `.gs` files, delete the old `Index` HTML file, run `authorize` once.
2. Deploy › New deployment › Web app — Execute as **Me**, Who has access **Anyone**. Copy the web app URL.
3. In this repository, edit `config.js` and paste the URL into `apiUrl`. Commit.
4. Settings › Pages › Deploy from a branch › `main` / root › Save. The app appears at `https://<account>.github.io/zobo/`.
5. Add the team in the Users tab.

After changing any `.gs` file: Deploy › Manage deployments › edit › New version (the URL stays the same).

## Who sees what: full ZOBO for the people you allow, a public assistant for viewers

| Role | Sees |
|---|---|
| **Buyer, Approver, Admin** (the people you allow) | All of ZOBO: the three modes (Chat, Deep research, Advanced), Reports, the Dashboard, Industry Expert, Quotations; Admin also has People. |
| **Viewer** (for example anyone who signs in with Google) | Only Assistant, My results, Expert and Cart, run on a separate AI. Never the company reports, dashboard, quotations, news, supplier runs or company AI. The server refuses those actions for viewers, whatever the page asks. |

What viewers get:
- **Assistant:** answers any question and searches the web (Google Search inside Gemini). For a shopping question, for example "where can I buy a sock knitting machine under 5 lakh" or a photo with "where can I get this", it shows **product cards** with the price, picture and seller, plus **Add to cart** and **Buy on site**.
- **My results:** only their own searches and answers, newest first.
- **Expert:** in-depth answers on industry, machinery, manufacturing, textiles, business and quality, with sources.
- **Cart:** products saved from their results, quantity, an estimated total and **Buy on site** for each one. Payment happens on the seller's own site; ZOBO never takes payments.
- **Product links are always real pages.** ZOBO opens every page the search found and keeps only pages that sell the product. The price comes from the page itself (or the search, marked "check on the site"). A link is never made up.

**The viewer AI is separate.** Set it with **ZOBO › Set viewer AI key**: a free Gemini key made in a new project at aistudio.google.com (its own free limit, so viewers never use up the company's AI or SerpApi).

**Fair-use limits:**
- each viewer: 10 messages a minute, 80 an hour, 100 a day;
- all viewers together: 5,000 web requests a day (Script property `VIEWER_FETCH_DAILY`), so supplier runs always have enough.

**Where the data is kept:** viewer searches go in the **Viewer Results** tab, and carts in **Viewer Carts**. When Viewer Results passes 6,000 rows, the oldest 1,000 are removed.

## The three modes of the Assistant

Pick the mode with the three buttons above the message box. Only the buttons change it; ZOBO never switches by itself. ZOBO remembers the mode for each person on each computer.

| Mode | What it does | Time |
|---|---|---|
| **Chat** | Answers any question on any topic, like ChatGPT, Claude or Gemini: Excel, emails, translations, maths, advice. It looks things up on Google when the question needs current facts, and shows the sources as links. It also knows the latest report. | seconds |
| **Deep research** | Researches machines, industrial equipment and industrial knowledge. It runs several rounds of web search in English and Chinese, reads the best pages, and cites every fact with its numbered source and a confidence line. | 1 to 3 minutes |
| **Advanced** | Finds the **top five**, compares them and gives a **final choice**. It reads the task, and any file or photo, then acts on it. | see below |

What Advanced does with a task:
- **A machine to buy** (for example "find suppliers for this", or a photo or spec sheet of a machine) runs the full supplier search. ZOBO finds the top five Chinese makers, vets them, compares them in the report, and the expert committee makes the final pick. This takes 15 to 30 minutes, and it starts only after you answer yes. **Quick top-5 comparison** gives a researched comparison instead, in 2 to 3 minutes.
- **Anything else** gets a researched top-five comparison with a final choice (for example "compare the best yarn dyeing technologies"), or a researched answer about the file (for example "check this quotation").

**Files and photos.** Attach them with the paperclip, paste a picture, or drag files onto the conversation. This works in every mode. ZOBO reads:
- photos (JPG, PNG, WebP, HEIC);
- PDFs;
- Word (.docx) and Excel (.xlsx, .xls) files;
- CSV and text files.

Limits: up to 4 files and 10 MB at a time. Photos are made smaller in the browser before sending. Word and Excel files are read in the browser, by the readers in `vendor/`. Files are read for the answer and not stored. They go only to Google's Gemini.

Fair-use limits per person: 20 messages a minute, 40 researched answers an hour, and 60 file messages an hour.

Saying "deep research mode" or "deep research off" still works and does the same as pressing the button. "deep research on X" gives one deep answer.

## Deep research mode: when it is on, and when it is not

| What you do | What happens |
|---|---|
| Press **Deep research** (Assistant, Industry Expert, or the report's Ask ZOBO bar), or say "deep research mode", "turn on deep research", "डीप रिसर्च मोड चालू करो" | Switched **on** for you on this computer, until you switch it off |
| Say "deep research off", "stop deep research", "don't use deep research", "डीप रिसर्च बंद करो" | Switched **off** |
| Say "deep research on boilers", "deep research: कपास", "deep research Chinese sock machine makers" | **One** deep answer for that topic; the mode stays as it was |
| Ask "is deep research on?", "deep research kya hai", "what is deep research mode?" | ZOBO tells you whether it is on and what it does; nothing changes |
| Anything else | Normal, faster mode |

A supplier search remembers the mode it was started in. In **normal mode** ZOBO still runs one small **gap search** per company for missing facts
(Settings row "Deep research searches per company": default 1, 0 = off, up to 3). The status line calls it "Gap search", never "deep research".

- **Questions in deep mode:** ZOBO plans the research, searches Google, Google News, Baidu and Bing China, reads the most trustworthy pages, checks what is missing or contradictory, searches again, then answers with numbered sources, a confidence line and the steps it took. About 1 to 3 minutes.
- **Supplier searches in deep mode:** wider searches (trade platforms and the best-known makers by name), more pages read per company, up to three rounds of gap research (the last also through Google Search with Gemini), and two different AIs checking every fact. About 15 to 30 minutes and about 120 searches.

### Speed

The research work itself takes about 4 to 6 minutes; the rest is waiting for free limits. Without changing the research:
- **Search memory:** a search made in the last 6 hours (same words, same engine) is answered from memory with the same results, so a company researched again after a pause, or the next run for the same machine, does not spend searches twice.
- **Quick resume:** after the hourly search limit, ZOBO asks SerpApi every 2 minutes (a free account check, not a search) how many searches the hour has left, and goes on the moment it can, instead of resting a fixed hour.
- **For no waiting at all,** add more free search capacity in ZOBO › Set backup keys: a second SerpApi account (another Gmail; 50 more an hour, 250 a month) and a free Serper key (2,500 searches). A deep run needs about 120 searches, and one free SerpApi key allows 50 an hour.

### When the free search limit runs out in the middle of a run

SerpApi's free plan allows 50 searches an hour. A normal run uses 50; a deep run about 120. When the hourly limit is used up and no backup search key is set,
ZOBO **pauses for 10 minutes and continues by itself** (up to 7 times) instead of writing a report on empty research. If it still cannot search, it finishes and
says plainly which research is partial. A second SerpApi key or a free Serper or Tavily key avoids the waiting.

## Quotations and payment safety

Supplier replies are checked every hour: every new message in the thread, revised prices and PDF or photo attachments. Each reply is checked for payment-fraud signs:
a new or changed bank account, a beneficiary that is not the registered company, a bank outside mainland China, an account different from the one given first,
or a reply from a different (look-alike) address. Any of these marks the quote with a red payment warning and emails the purchase contact. Always confirm bank details
by phone, on the number in the official registry record, before paying.

## Limits on the free plan

- SerpApi: 250 searches a month, 50 an hour. A supplier search uses about 50 (deep research mode about 120); an Industry Expert news question up to 2, a deep question up to 10. Free backup search keys (Serper, Tavily, SearchApi.io) take over automatically when SerpApi runs out.
- Google Search through Gemini (deep research): about 500 free questions a day on Gemini 2.5 Flash.
- Gemini free tier: Google may use what is sent to improve its products. Only the machine request, public supplier information and email text are sent.
- Apps Script: emails are sent from the Google account that deployed the script (use a shared purchase account).
