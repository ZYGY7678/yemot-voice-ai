הפעלת האתר (פעם אחת, על ידי מי שמפעיל את האתר)
1. npm install
2. npm start   (משתנה PORT אופציונלי)
3. אופציונלי - כפתור "התחברות עם GitHub" (OAuth):
   צרו OAuth App ב-https://github.com/settings/applications/new
   Callback URL: BASE_URL/auth/callback
   הגדירו: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BASE_URL (כתובת האתר ב-https)
   בלי המשתנים האלה האתר עובד עם טוקן GitHub שהמשתמש מדביק.
