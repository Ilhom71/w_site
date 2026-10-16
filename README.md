# Waynox Freight website

Static site plus a small Node server that forwards form submissions to Telegram.

## Structure

```
server.js          Node server: serves public/ and handles POST /api/lead -> Telegram
package.json       npm start = node server.js (Node 18+, no dependencies)
render.yaml        Render deploy config
.env.example       TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (copy to .env for local runs)

public/            Everything the browser gets
  index.html         Home (copy of Home.dc.html, served at /)
  *.dc.html          Pages: Home, About, Services, Safety, Drive-With-Us, FAQ, Contact, Legal, Request-Quote
                     Components: SiteHeader, SiteFooter, Icon, OfferCard
                     (pages and components must stay side by side: the runtime loads ./<Name>.dc.html)
  js/                support.js (page runtime), i18n.js (EN/UZ/RU), lead.js (form -> /api/lead)
  assets/            Logo, US map, Waynox truck renders
  assets/img/        Truck photos (credits on Legal page, #credits)

design/            Not deployed: decks, color studies, screenshots, review feedback, unused assets
```

## Run locally

```
cp .env.example .env   # fill in the bot token and chat id
npm start              # http://localhost:3000
```

When you edit `public/Home.dc.html`, copy it to `public/index.html` as well.

## Who receives form submissions

- Every chat id in `TELEGRAM_CHAT_ID` (comma-separated).
- Everyone who opens the bot and sends `/start <code>`, where `<code>` is `TELEGRAM_JOIN_CODE`.
  `/stop` unsubscribes. Keep the code private: whoever has it receives applicants' names and phones.

Joined recipients are saved to `data/recipients.json` and to a message the bot pins in the first
`TELEGRAM_CHAT_ID` chat, so the list survives restarts on Render's free plan. Don't unpin or delete that message.
Only one server may poll the bot at a time: leave `TELEGRAM_JOIN_CODE` empty in a local `.env` while the live site runs.
