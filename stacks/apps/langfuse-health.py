"""Check object storage, Langfuse database readiness, and native API auth."""
import json
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def check(url, expected, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status != expected:
                raise SystemExit(f'{url}: expected HTTP {expected}, got {response.status}')
            return response.read()
    except OSError:
        raise SystemExit(f'{url}: readiness request failed')


check('http://127.0.0.1:9095/minio/health/ready', 200)
health_url = 'http://127.0.0.1:3035/api/public/health?failIfDatabaseUnavailable=true'
try:
    health = json.loads(check(health_url, 200))
except (ValueError, UnicodeError):
    raise SystemExit('Langfuse readiness returned invalid JSON')
if not isinstance(health, dict) or health.get('status') != 'OK':
    raise SystemExit('Langfuse database readiness did not report OK')

projects_url = 'http://127.0.0.1:3035/api/public/projects'
check(projects_url, 401)
check(projects_url, 401, {'Authorization': 'Basic aW52YWxpZDppbnZhbGlk'})
print('Langfuse database and object storage ready; native API rejects missing and invalid credentials')
