import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, PriceScaleMode } from 'lightweight-charts';

interface TradingViewChartProps {
  data: any[];
  showEMA20?: boolean;
  showEMA50?: boolean;
  showBB?: boolean;
  showMomentum?: boolean;
  showVolume?: boolean;
  chartType?: 'line' | 'candle';
  trades?: any[];
}

export const TradingViewChart: React.FC<TradingViewChartProps> = ({ 
  data, 
  showEMA20 = true, 
  showEMA50 = true,
  showBB = false,
  showMomentum = true,
  showVolume = false,
  chartType = 'candle',
  trades = []
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const momentumSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersCandleRef = useRef<any>(null);
  // ... other refs
  const ema20SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#D9D9D9',
      },
      grid: {
        vertLines: { color: '#00000000' },
        horzLines: { color: '#111' },
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      timeScale: {
        borderColor: '#111',
        timeVisible: true,
      },
    });

    const momentum = chart.addSeries(HistogramSeries, {
      color: '#10b981',
      priceFormat: { type: 'volume' },
      priceScaleId: 'momentum',
    });

    const volume = chart.addSeries(HistogramSeries, {
      color: '#ffffff10',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });

    chart.priceScale('momentum').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      visible: false,
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      visible: false,
    });

    const candlestick = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // Main line series is the line-mode fallback for candlestick. White-ish so it doesn't
    // collide with the yellow EMA20 label when both are on.
    const mainLine = chart.addSeries(LineSeries, {
      color: '#e5e7eb',
      lineWidth: 2,
    });

    // Indicator overlays — last-value labels and price-lines hidden so they don't stack into
    // a wall of unreadable chips on the right edge when several are on at once.
    const indicatorOpts = { lastValueVisible: false, priceLineVisible: false } as const;
    const ema20 = chart.addSeries(LineSeries, { color: '#fbbf24', lineWidth: 1, ...indicatorOpts });
    const ema50 = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, ...indicatorOpts });
    const bbUpper = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, lineStyle: 1, ...indicatorOpts });
    const bbLower = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, lineStyle: 1, ...indicatorOpts });

    chartRef.current = chart;
    candlestickSeriesRef.current = candlestick;
    lineSeriesRef.current = mainLine;
    momentumSeriesRef.current = momentum;
    volumeSeriesRef.current = volume;
    markersCandleRef.current = createSeriesMarkers(candlestick, []);
    ema20SeriesRef.current = ema20;
    ema50SeriesRef.current = ema50;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;

    // Resize on window AND on container resize. The latter matters when the user expands
    // the chart panel into fullscreen — the parent grid cell changes shape, but window
    // doesn't fire a resize event, so the chart would otherwise stay frozen at its old
    // dimensions and clip half its content.
    const handleResize = () => {
      const el = chartContainerRef.current;
      if (!el) return;
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    };
    window.addEventListener('resize', handleResize);
    const ro = new ResizeObserver(handleResize);
    if (chartContainerRef.current) ro.observe(chartContainerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      ro.disconnect();
      chart.remove();
    };
  }, []);

  // Track the data window we last rendered so we can detect a token switch (different time
  // range) and call fitContent() — without this the chart stays anchored to the previous
  // token's window and the new candles render outside the visible range, looking blank.
  const lastFirstTime = useRef<number | null>(null);
  const lastLastTime = useRef<number | null>(null);
  useEffect(() => {
    if (!chartRef.current || !candlestickSeriesRef.current) return;

    // When data goes empty (interval has no candles for this token, token deselected, etc.)
    // CLEAR every series — the prior return-early left the previous token/interval's candles
    // rendered indefinitely, masking the empty state. We still reset lastFirst/Last so the
    // next non-empty render triggers fitContent.
    if (!data.length) {
      candlestickSeriesRef.current.setData([]);
      lineSeriesRef.current?.setData([]);
      momentumSeriesRef.current?.setData([]);
      volumeSeriesRef.current?.setData([]);
      ema20SeriesRef.current?.setData([]);
      ema50SeriesRef.current?.setData([]);
      bbUpperSeriesRef.current?.setData([]);
      bbLowerSeriesRef.current?.setData([]);
      markersCandleRef.current?.setMarkers([]);
      lastFirstTime.current = null;
      lastLastTime.current = null;
      return;
    }

    const timeScale = (d: any) => Math.floor(d.time / 1000) as any;

    const candleData = data.map(d => ({
      time: timeScale(d),
      open: d.open, high: d.high, low: d.low, close: d.close,
    }));

    const momentumData = data.map(d => ({
      time: timeScale(d),
      value: d.momentum,
      color: d.momentum > 0 ? '#10b981' : '#ef4444',
    }));

    const volumeData = data.map(d => ({
      time: timeScale(d),
      value: d.volume || Math.random() * 1000,
      color: d.close > d.open ? '#10b98140' : '#ef444440',
    }));

    // Auto-scale price precision so sub-cent tokens (pump.fun memecoins) don't render as $0.00
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const d of data) {
      const lo = Math.min(d.open ?? Infinity, d.high ?? Infinity, d.low ?? Infinity, d.close ?? Infinity);
      const hi = Math.max(d.open ?? -Infinity, d.high ?? -Infinity, d.low ?? -Infinity, d.close ?? -Infinity);
      if (lo > 0 && lo < minPrice) minPrice = lo;
      if (Number.isFinite(hi) && hi > maxPrice) maxPrice = hi;
    }
    const precision = Number.isFinite(minPrice) && minPrice > 0
      ? Math.max(2, Math.min(12, -Math.floor(Math.log10(minPrice)) + 3))
      : 2;
    const minMove = Math.pow(10, -precision);
    const priceFormat = { type: 'price' as const, precision, minMove };
    candlestickSeriesRef.current.applyOptions({ priceFormat });
    lineSeriesRef.current?.applyOptions({ priceFormat });
    ema20SeriesRef.current?.applyOptions({ priceFormat });
    ema50SeriesRef.current?.applyOptions({ priceFormat });
    bbUpperSeriesRef.current?.applyOptions({ priceFormat });
    bbLowerSeriesRef.current?.applyOptions({ priceFormat });

    // Auto log scale when the price range spans more than ~10x — keeps memecoin pumps
    // and corrections from flattening every other candle on a linear y-axis.
    const useLog = Number.isFinite(minPrice) && minPrice > 0 && maxPrice / minPrice > 10;
    chartRef.current.priceScale('right').applyOptions({
      mode: useLog ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });

    candlestickSeriesRef.current.setData(candleData);
    lineSeriesRef.current?.setData(data.map(d => ({ time: timeScale(d), value: d.close })));
    momentumSeriesRef.current?.setData(showMomentum ? momentumData : []);
    volumeSeriesRef.current?.setData(showVolume ? volumeData : []);

    if (chartType === 'candle') {
      candlestickSeriesRef.current.applyOptions({ visible: true });
      lineSeriesRef.current?.applyOptions({ visible: false });
    } else {
      candlestickSeriesRef.current.applyOptions({ visible: false });
      lineSeriesRef.current?.applyOptions({ visible: true });
    }

    // Sync indicators
    const syncSeries = (series: ISeriesApi<"Line"> | null, show: boolean, key: string) => {
      if (!series) return;
      series.setData(show ? data.filter(d => d[key] !== undefined).map(d => ({ time: timeScale(d), value: d[key] })) : []);
    };
    syncSeries(ema20SeriesRef.current, showEMA20, 'ema20');
    syncSeries(ema50SeriesRef.current, showEMA50, 'ema50');
    syncSeries(bbUpperSeriesRef.current, showBB, 'bbUpper');
    syncSeries(bbLowerSeriesRef.current, showBB, 'bbLower');

    // Trade Markers
    if (trades.length) {
      const markers = trades.map(t => {
        const isBuy = t.type === 'buy' || t.tradeType === 'buy' || t.tradeType === 'LONG';
        return {
          time: timeScale(t),
          position: isBuy ? 'belowBar' : 'aboveBar' as any,
          color: isBuy ? '#10b981' : '#ef4444',
          shape: isBuy ? 'arrowUp' : 'arrowDown' as any,
          text: isBuy ? 'BUY' : 'SELL',
        };
      }).sort((a, b) => a.time - b.time);
      markersCandleRef.current.setMarkers(markers);
    } else {
      markersCandleRef.current.setMarkers([]);
    }

    // Re-fit the time scale ONLY when the dataset's time range changes (token switch /
    // period change). If the user scrolled or zoomed and we're just appending candles to
    // the same series, leave the user's view alone.
    const firstTime = candleData[0]?.time ?? null;
    const lastTime = candleData[candleData.length - 1]?.time ?? null;
    const rangeChanged =
      firstTime !== lastFirstTime.current ||
      // First-render guard: lastLastTime is null on mount.
      (lastLastTime.current === null && lastTime !== null) ||
      // A backwards jump in last-time means a different (shorter) dataset, also a switch.
      (lastTime !== null && lastLastTime.current !== null && lastTime < lastLastTime.current);
    if (rangeChanged) {
      chartRef.current.timeScale().fitContent();
    }
    lastFirstTime.current = firstTime;
    lastLastTime.current = lastTime;
  }, [data, showEMA20, showEMA50, showBB, showMomentum, showVolume, chartType, trades]);

  return (
    <div ref={chartContainerRef} style={{ width: '100%', height: '100%', minHeight: '300px' }}>
      {!data.length && (
        <div className="absolute inset-0 flex items-center justify-center text-[#333] font-black text-[10px] uppercase tracking-widest">
          Synchronizing Core Data...
        </div>
      )}
    </div>
  );
};
