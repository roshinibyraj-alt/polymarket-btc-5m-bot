import json,time,urllib.request
    import pandas as pd
    from sklearn.ensemble import RandomForestClassifier
    URL="https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1000"
    HORIZONS=(4,8,12,16,20);TARGET=.0052

    def main():
     req=urllib.request.Request(URL,headers={"User-Agent":"paper-model/1.0"})
     with urllib.request.urlopen(req,timeout=12) as r: raw=json.load(r)
     now=int(time.time()*1000);rows=[(int(x[0]),float(x[1]),float(x[2]),float(x[3]),float(x[4])) for x in raw if int(x[6])<now]
     df=pd.DataFrame(rows,columns=["time","open","high","low","close"])
     if len(df)<300: raise ValueError("Need at least 300 completed 15-minute candles")
     df["target"]=(((df["close"].shift(-1)-df["close"])/df["close"])>TARGET).astype(int);features=[]
     for h in HORIZONS:
      r,t=f"close_ratio_{h}",f"trend_{h}";df[r]=df.close/df.close.rolling(h).mean();df[t]=df.target.shift(1).rolling(h).sum();features.extend([r,t])
     valid=df.dropna(subset=features).reset_index(drop=True)
     if len(valid)<251: raise ValueError("Not enough rows after feature warmup")
     latest=valid.iloc[[-1]][features];labeled=valid.iloc[:-1];split=len(labeled)-200
     if split<50: raise ValueError("Not enough training examples")
     train,test=labeled.iloc[:split],labeled.iloc[split:]
     model=RandomForestClassifier(n_estimators=200,min_samples_split=50,random_state=1,n_jobs=1);model.fit(train[features],train.target)
     accuracy=float((model.predict(test[features])==test.target).mean()) if len(test) else None
     probs=model.predict_proba(latest)[0];p=float(probs[list(model.classes_).index(1)]) if 1 in model.classes_ else 0.0
     print(json.dumps({"ready":True,"status":"ready","modelVersion":"roulette-rf-15m-v1","signal":"UP" if p>=.60 else None,"probabilityStrongUp":p,"threshold":.60,"targetReturn":TARGET,"validationAccuracy":accuracy,"trainingRows":len(train),"validationRows":len(test),"latestCandleAt":int(valid.iloc[-1].time)}))
    if __name__=="__main__":
     try: main()
     except Exception as e: print(json.dumps({"ready":False,"status":"error","reason":str(e)}))
    