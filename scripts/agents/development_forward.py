"""Restore only Cortex development forwarding after Docker or Incus restarts."""
from common import run


def main():
    if '-N DOCKER-USER' not in run('iptables', '-S'):
        return
    rules = run('iptables', '-S', 'DOCKER-USER').splitlines()
    for args in (['-i', 'cortexdev0', '-j', 'ACCEPT'],
                 ['-o', 'cortexdev0', '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT']):
        if '-A DOCKER-USER ' + ' '.join(args) not in rules:
            run('iptables', '-I', 'DOCKER-USER', '1', *args)


if __name__ == '__main__':
    main()
