const { S3Client } = require("@aws-sdk/client-s3");
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const {
  toProduct,
  uploadToS3,
  s3FileName,
  shopName,
  invalidateCDN
} = require("@hlidac-shopu/actors-common/product.js");
const rollbar = require("@hlidac-shopu/actors-common/rollbar.js");
const Apify = require("apify");

/** @typedef { import("apify").CheerioHandlePage } CheerioHandlePage */
/** @typedef { import("apify").CheerioHandlePageInputs } CheerioHandlePageInputs */
/** @typedef { import("apify").RequestQueue } RequestQueue */

const { log } = Apify.utils;

const baseUrl = "https://www.kosik.cz/";

const slug = url => url.substring(1);
const listingUrl = ({ url }) =>
  `${baseUrl}api/web/page/products?slug=${slug(url)}&limit=60`;

const slugBF = url => new URL(url).pathname.substring(1);
const listingBFUrl = url =>
  `${baseUrl}api/web/page/products?slug=${slugBF(url)}&limit=60`;

function* categoriesTree(root) {
  for (const category of root) {
    if (category.subcategories) yield* categoriesTree(category.subcategories);
    yield listingUrl(category);
  }
}

/**
 *
 * @param {RequestQueue} requestQueue
 * @param categories
 * @returns {Promise<void>}
 */
async function enqueueCategories(requestQueue, { categories }) {
  for (const url of categoriesTree(categories)) {
    await requestQueue.addRequest({
      url,
      userData: { step: "DETAIL" }
    });
  }
}

/**
 *
 * @param {RequestQueue} requestQueue
 * @param products
 * @returns {Promise<void>}
 */
async function enqueuePagination(requestQueue, { products }) {
  if (products?.more) {
    await requestQueue.addRequest({
      url: products.more,
      userData: { step: "DETAIL" }
    });
  }
}

const parseItem = (item, breadcrumbs) => ({
  itemId: item.id,
  itemUrl: new URL(item.url, baseUrl).href,
  itemName: item.name,
  discounted: item.percentageDiscount > 0,
  discountedName:
    item.percentageDiscount > 0 ? `${item.percentageDiscount} %` : null,
  currentPrice: item.price,
  originalPrice:
    item.price == item.recommendedPrice ? null : item.recommendedPrice,
  inStock: !item.firstOrderDay,
  category: breadcrumbs,
  img: item.image
});

/**
 * @param {RequestQueue} requestQueue
 * @param {S3Client} s3
 * @returns {CheerioHandlePage}
 */
function pageFunction(requestQueue, s3) {
  const processedIds = new Set();

  /**
   *  @param {CheerioHandlePageInputs} context
   *  @returns {Promise<void>}
   */
  async function handlePageFunction(context) {
    const { request, response, json } = context;
    if (response.statusCode !== 200) {
      log.info("Status code:", response.statusCode);
    }

    const { step } = request.userData;
    if (step === "CATEGORIES") {
      await enqueueCategories(requestQueue, json);
    } else if (step === "DETAIL") {
      await enqueuePagination(requestQueue, json);

      const breadcrumbs =
        json.breadcrumbs?.map(x => x.name)?.join(" > ") ?? json.title;
      for (const item of json.products.items) {
        if (processedIds.has(item.id)) continue;
        const detail = parseItem(item, breadcrumbs);
        const shop = await shopName(baseUrl);
        const slug = await s3FileName(detail);
        await Promise.all([
          Apify.pushData({ ...detail, shop, slug }),
          uploadToS3(
            s3,
            "kosik.cz",
            slug,
            "jsonld",
            toProduct(detail, { priceCurrency: "CZK" })
          )
        ]);
        processedIds.add(item.id);
      }
    }

    log.info("handled page", { url: request.url });
  }

  return handlePageFunction;
}

function getTableName(country) {
  return `kosik`;
}

Apify.main(async () => {
  rollbar.init();

  const s3 = new S3Client({ region: "eu-central-1" });
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });

  const input = await Apify.getInput();
  const {
    country = "cz",
    development,
    maxConcurrency = 4,
    proxyGroups = ["CZECH_LUMINATI"],
    type,
    bfUrls = ["https://www.kosik.cz/listy/bf-nanecisto-2021"]
  } = input ?? {};

  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: development ? undefined : proxyGroups,
    useApifyProxy: !development
  });

  /** @type {RequestQueue} */
  const requestQueue = await Apify.openRequestQueue();
  if (type === "BF") {
    for (const url of bfUrls) {
      await requestQueue.addRequest({
        url: listingBFUrl(url),
        userData: {
          step: "DETAIL"
        }
      });
    }
  } else {
    await requestQueue.addRequest({
      url: "https://www.kosik.cz/api/web/menu/main",
      userData: {
        step: "CATEGORIES"
      }
    });
  }

  const crawler = new Apify.CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries: 3,
    requestTimeoutSecs: 60,
    additionalMimeTypes: ["application/json", "text/plain"],
    handlePageFunction: pageFunction(requestQueue, s3),
    handleFailedRequestFunction: async ({ request }) => {
      log.error(`Request ${request.url} failed multiple times`, request);
    }
  });

  await crawler.run();
  log.info("crawler finished");

  if (!development) {
    await invalidateCDN(cloudfront, "EQYSHWUECAQC9", "kosik.cz");
    log.info("invalidated Data CDN");

    try {
      let tableName = getTableName(country);
      if (type === "BF") {
        tableName = `${tableName}_bf`;
      }
      await uploadToKeboola(tableName);
      log.info("upload to Keboola finished");
    } catch (err) {
      log.warning("upload to Keboola failed");
      log.error(err);
    }
  }
});
