import yfinance as yf

FIELD_METADATA = {
    "sector": {"unit": None, "type": "text"},
    "industry": {"unit": None, "type": "text"},
    "currentPrice": {"unit": "USD", "type": "currency"},
    "marketCap": {"unit": "USD", "type": "currency"},
    "enterpriseValue": {"unit": "USD", "type": "currency"},
    "52WeekChange": {"unit": "%", "type": "percentage"},
    "fiftyTwoWeekHigh": {"unit": "USD", "type": "currency"},
    "fiftyTwoWeekLow": {"unit": "USD", "type": "currency"},
    "fiftyDayAverage": {"unit": "USD", "type": "currency"},
    "twoHundredDayAverage": {"unit": "USD", "type": "currency"},
    "averageVolume10days": {"unit": "shares", "type": "volume"},
    "trailingPE": {"unit": "x", "type": "multiple"},
    "forwardPE": {"unit": "x", "type": "multiple"},
    "pegRatio": {"unit": "x", "type": "multiple"},
    "priceToBook": {"unit": "x", "type": "multiple"},
    "priceToSalesTrailing12Months": {"unit": "x", "type": "multiple"},
    "enterpriseToRevenue": {"unit": "x", "type": "multiple"},
    "enterpriseToEbitda": {"unit": "x", "type": "multiple"},
    "dividendRate": {"unit": "USD", "type": "currency"},
    "dividendYield": {"unit": "%", "type": "percentage"},
    "payoutRatio": {"unit": "%", "type": "percentage"},
    "shortPercentOfFloat": {"unit": "%", "type": "percentage"},
    "shortRatio": {"unit": "days", "type": "ratio"},
}

FRACTION_TO_PERCENT = {"52WeekChange", "shortPercentOfFloat", "payoutRatio"}

def generate_current_data(ticker: str) -> dict:
    info = yf.Ticker(ticker).info
    data = {}
    for field, meta in FIELD_METADATA.items():
        val = info.get(field)
        if val is not None and field in FRACTION_TO_PERCENT:
            val = round(val * 100, 2)
        data[field] = {"value": val, "unit": meta["unit"], "type": meta["type"]}

    rate = data["dividendRate"]["value"]
    price = data["currentPrice"]["value"]
    data["dividendYield"]["value"] = round(rate / price * 100, 2) if rate and price else None
    return data

#needs more work
def generate_historical_data(ticker: str):
    stock_data = yf.Ticker(ticker).history(period="5y", interval="1mo")
    return stock_data

