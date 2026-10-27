import re
from pathlib import Path

target_path = Path("/app/admin.js")
source = target_path.read_text(encoding="utf-8")

def replace_once(source, old, new, label, required=True):
    count = source.count(old)
    if count != 1:
        if not required and count == 0:
            print(f"PATCH_OPTIONAL_NOT_FOUND: {label}")
            return source
        raise RuntimeError(f"Patch anchor {label!r} expected once, found {count}")
    print(f"PATCH_OK: {label}")
    return source.replace(old, new, 1)

def regex_once(source, pattern, replacement, label, required=True, flags=0):
    result, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        if not required:
            print(f"PATCH_OPTIONAL_NOT_FOUND: {label}")
            return source
        raise RuntimeError(f"Regex patch {label!r} expected once, found {count}")
    print(f"PATCH_OK: {label}")
    return result

source = regex_once(
    source,
    r"renderSetupPage\(\)(?!\s*\{)",
    "renderAuthPage()",
    "show login form instead of setup wizard"
)

source = replace_once(
    source,
    "    const refreshToken = jsonCookie(req, 'ym_auth');",
    """    const refreshToken = jsonCookie(req, 'ym_auth');
    if (!firebaseConfigured() && String(refreshToken || '').startsWith('local-admin:')) {
      const username = String(process.env.DASHBOARD_USERNAME || '');
      const password = String(process.env.DASHBOARD_PASSWORD || '');
      if (!username || !password) { clearAuthCookie(res); return null; }
      const expectedToken = 'local-admin:' + crypto.createHmac('sha256', password).update(username).digest('hex');
      if (refreshToken !== expectedToken) { clearAuthCookie(res); return null; }
      return { uid: 'local-admin', email: username, displayName: username, idToken: expectedToken, refreshToken: expectedToken, local: true };
    }""",
    "validate signed local admin session"
)

source = replace_once(
    source,
    "  app.post('/auth/login', async (req, res) => {",
    """  app.post('/auth/login', (req, res, next) => {
    if (firebaseConfigured()) return next();
    const username = String(req.body?.email ?? req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const expectedUsername = String(process.env.DASHBOARD_USERNAME || '');
    const expectedPassword = String(process.env.DASHBOARD_PASSWORD || '');
    if (!expectedUsername || !expectedPassword || username !== expectedUsername || password !== expectedPassword) {
      return res.status(401).send('שם המשתמש או הסיסמה אינם נכונים.');
    }
    const token = 'local-admin:' + crypto.createHmac('sha256', expectedPassword).update(expectedUsername).digest('hex');
    setAuthCookie(res, token);
    return res.send('התחברת בהצלחה.');
  });
  app.post('/auth/login', async (req, res) => {""",
    "enable local admin username and password login"
)

source = replace_once(
    source,
    "  app.post('/auth/register', async (req, res) => {",
    """  app.post('/auth/register', (req, res, next) => {
    if (firebaseConfigured()) return next();
    return res.status(503).send('הרשמה חדשה עם אימות מייל דורשת חיבור שירות אימות חד-פעמי. אפשר להתחבר לחשבון המנהל עם שם המשתמש והסיסמה שהוגדרו ב-Render.');
  });
  app.post('/auth/register', async (req, res) => {""",
    "explain verified signup requires Firebase configuration"
)

source = regex_once(
    source,
    r'<label>כתובת מייל</label>\s*<input type="email" id="email" autocomplete="email" required>',
    '<label>שם משתמש או כתובת מייל</label><input type="text" id="email" autocomplete="username" required>',
    "allow username input on login page",
    required=False
)
source = replace_once(
    source,
    'ההרשמה מוגנת באימות מייל. האתר מוגדר כחשבון מנהל אישי, לכן אפשר להירשם רק באמצעות כתובת המייל שהוגדרה בהתקנה.',
    'התחברות למנהל באמצעות שם משתמש וסיסמה. הרשמה חדשה עם אימות מייל דורשת הגדרת שירות האימות.',
    "clarify login and signup state",
    required=False
)

target_path.write_text(source, encoding="utf-8")
