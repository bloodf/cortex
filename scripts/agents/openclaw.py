"""Install the immutable runtime; named processes are dispatched by manage.py."""
from common import finish, runtime


def main(action, manifest):
    runtime("openclaw", action, manifest)
    if action in ('start', 'stop', 'restart'):
        from manage import agent
        for index, spec in enumerate(sorted(manifest.get('agents', []), key=lambda item: item['name'])):
            if spec['runtime'] == "openclaw":
                agent(action, manifest, spec, 18800 + index)


if __name__ == '__main__':
    finish(main)
