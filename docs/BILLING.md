# BookForgeAI — Billing

## Publishing price

**$100 USD per book**

```env
BOOK_PUBLISHING_PRICE_USD=100
BOOK_PUBLISHING_CURRENCY=usd
```

The $100 is the BookForgeAI publishing charge. It is not a claim that AI, printing, storage or payment processing costs exactly $100.

## Product flow

```text
DRAFT → BOOK COMPLETE → PREVIEW → PUBLISH FOR $100 → PAYMENT → FINAL PDF
```

Creation may happen before payment. Publication is the paid conversion event.

## Stripe rules

Create the checkout session server-side. Never trust a client-supplied amount. The verified payment webhook is authoritative.

## Accounting

Track revenue, OpenAI text cost, OpenAI image cost, storage, compute, payment fees and other costs. Calculate contribution margin per book.
