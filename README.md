# PharmaLink Local Setup

## Run on localhost

1. Open the project in VS Code.
2. Open the terminal in `E:\PharmaLInk 2.0`.
3. Create `.env` from `.env.example` and fill in your Supabase and EmailJS values.
4. Install dependencies:

```bash
npm install
```

5. Start the local server:

```bash
npm run dev
```

6. Open:

```text
http://localhost:3000/login.html
```

## Notes

- Do not open the HTML files directly with `file://`.
- This project uses ES modules, so it must run through a local server.
- Credentials are loaded from `.env` through Vite.
- `npm run build` now includes `index.html`, `login.html`, `dashboard.html`, and every page under `pages/`.
- `npm run dev` will automatically open `login.html` in your browser.

## Railway Deploy

1. Push this project to GitHub.
2. Create a Railway project from that repo.
3. Add these Railway Variables:

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_EMAILJS_PUBLIC_KEY=...
VITE_EMAILJS_SERVICE_ID=...
VITE_EMAILJS_TEMPLATE_ID=...
```

4. Use:

```text
Build Command: npm run build
Start Command: npm start
```
