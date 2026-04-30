import { useState, useEffect, useRef } from 'react';

export interface TickerData {
  p: string; // price
  s: string; // symbol
  t: number; // time
  v: string; // volume
}

// Only "<BASE>USDT" tickers (3-12 base chars + USDT) are tradable on Binance via this stream.
// Anything else (SPL mint addresses, free-form symbols) would fail the handshake and spam the console.
const BINANCE_PAIR = /^[A-Z]{2,12}USDT$/i;

export function useLivePrice(symbol: string = 'SOLUSDT') {
  const [price, setPrice] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!symbol || !BINANCE_PAIR.test(symbol)) {
      // Not a Binance pair (e.g. Solana mint address). Skip the connection entirely.
      setPrice(0);
      return;
    }

    const streamUrl = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(streamUrl);
    } catch {
      return;
    }
    ws.current = socket;

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setPrice(parseFloat(data.c));
        setVolume(parseFloat(data.v));
        setLastUpdate(data.E);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onerror = () => { /* swallowed; UI falls back to last candle close */ };

    return () => {
      socket.close();
    };
  }, [symbol]);

  return { price, volume, lastUpdate };
}
