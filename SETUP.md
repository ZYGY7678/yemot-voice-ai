# SETUP

## משתני סביבה
- GEMINI_API_KEYS
- YEMOT_API_KEY
- DASHBOARD_PASSWORD
- PUBLIC_BASE_URL
- GEMINI_MODELS
- PER_MODEL_TIMEOUT_MS
- REQUEST_TIMEOUT_MS
- MODEL_COOLDOWN_MS

## הרצה מקומית
npm install
npm start

## Render
Runtime: Node
Build: npm install
Start: npm start

## הגדרת ימות
node yemot_setup/auto_setup_yemot.js <YEMOT_TOKEN> <RENDER_URL> 1

לאחר ההגדרה יש לבדוק את:
https://<RENDER_URL>/health
