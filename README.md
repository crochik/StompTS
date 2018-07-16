# StompTS
As now, this is JUST a little experiment. 

The original source was in coffeescript transpiled into javascript. 

This is manual port of it, starting with the javascript version. 

# How to use (work in progress)

```
    import Stomp from 'stompts';

    // ...

    var client = Stomp.client('ws://localhost:15674/ws');
    client.connect(
      {
        login: 'guest',
        passcode: 'guest'
      },
      (frame) => {
        console.log(`connected: ${frame}`);
        this.client.subscribe('/topic/test.#', (f) => {
          console.log(f);
        });
      }
    );
```

# The original
https://github.com/jmesnil/stomp-websocket

```
/*
   Stomp Over WebSocket http://www.jmesnil.net/stomp-websocket/doc/ | Apache License V2.0
   Copyright (C) 2010-2013 [Jeff Mesnil](http://jmesnil.net/)
   Copyright (C) 2012 [FuseSource, Inc.](http://fusesource.com)
 */
 ```
 
# Stomp Documentation
http://jmesnil.net/stomp-websocket/doc/