# YEMOT Voice AI

קו טלפון אישי מבוסס ימות המשיח ו-Google Gemini Audio.

## הפעלה
1. התקן Node.js 20 ומעלה.
2. הרץ `npm install`.
3. הגדר את משתני הסביבה לפי `.env.example`.
4. הרץ `npm start`.

## Render
הקובץ `render.yaml` מגדיר Web Service מסוג Node עם `npm install` ו-`npm start`.

## ימות המשיח
לאחר שהשרת זמין, הגדר את `PUBLIC_BASE_URL` והריץ:
`node yemot_setup/auto_setup_yemot.js <YEMOT_TOKEN> <RENDER_URL> 1`

בדיקת שרת:
`GET /health`

לוח הבקרה מוגן באמצעות `DASHBOARD_PASSWORD`.
