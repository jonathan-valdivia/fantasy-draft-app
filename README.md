# NFL Fantasy Draft Assistant

This is an application I built to be able to remotley participate in an offline draft. The idea was that I have a helper at the offline draft that marks players as they are taken. The app syncs over the web so I can see the results as they are put in. On my turn I mark my pick and the helper can see who I chose and mark it on the offline draft board.

## Where it runs

The app is built with docker. Presently it is hosted on a Digital Ocean Droplet.

## Notes to self

### to update the droplet

1. Open the droplet console

Run

```
$ cd /opt/fantasy-draft-app
$ git pull
$ docker compose build
$ docker compose up
```
