# Deploy Frontend + Backend to Netlify

## 1. Push project to GitHub
- Commit project, then push to your repository.

## 2. Create site in Netlify
- Open Netlify dashboard.
- Click `Add new site` -> `Import an existing project`.
- Choose your GitHub repository.

## 3. Build settings
- Build command: `npm run build`
- Publish directory: `build`
- Functions directory: `netlify/functions`

`netlify.toml` in this repo already configures the values above.

## 4. Environment variables in Netlify
Set these in `Site configuration` -> `Environment variables`:

- `REACT_APP_SUPABASE_URL` = your Supabase project URL
- `REACT_APP_SUPABASE_ANON_KEY` = your anon key
- `SUPABASE_SERVICE_ROLE_KEY` = your service role key (backend only)

Optional:
- `PORT` is not needed in Netlify Functions.

## 5. Deploy
- Click `Deploy site`.
- Wait until deploy is complete.

## 6. Verify
- Open `https://<your-site>.netlify.app/api/health`
- Expected result: `{ "ok": true }`

If this endpoint works, frontend and backend function routing are active.

## 7. Notes
- Local dev still works as before:
  - Frontend: `npm start`
  - Backend: `npm run server`
- In production (Netlify), frontend calls `/api/*`, then Netlify redirects to function `/.netlify/functions/api/*`.
