const browserAPI = typeof chrome !== "undefined" ? chrome : browser;

let config = {
	isActive: true,
	prefetchLevel: "medium", // プリフェッチの積極性（low, medium, high）
	batterySaving: false,
	dataSaver: false,
	whitelist: [],
	blacklist: [],
};

let stats = {
	totalTimeSaved: 0,
	prefetchedPages: 0,
	successfulPrefetches: 0,
	visitedUrls: new Map(),
	navigationPatterns: new Map(),
};

const sessionCache = {
	prefetchedUrls: new Set(),
	pendingPrefetches: new Map(),
	batteryStatus: null,
	networkType: "unknown",
};

async function initialize() {
	await loadStoredData();

	if ("getBattery" in navigator) {
		try {
			const battery = await navigator.getBattery();
			updateBatteryStatus(battery);

			// バッテリー状態変化のイベントリスナー
			battery.addEventListener("chargingchange", () =>
				updateBatteryStatus(battery)
			);
			battery.addEventListener("levelchange", () =>
				updateBatteryStatus(battery)
			);
		} catch (error) {
			console.error(
				"バッテリーAPIへのアクセス中にエラーが発生しました:",
				error
			);
		}
	}

	// ネットワーク接続状態の監視
	if ("connection" in navigator) {
		const connection = navigator.connection;
		updateNetworkStatus(connection);

		connection.addEventListener("change", () =>
			updateNetworkStatus(connection)
		);
	}
	// ログ
	console.log("PreCache Predictor が初期化されました");
}

// 保存されたデータの読み込み
async function loadStoredData() {
	try {
		// 設定の読み込み
		const storedConfig = await browserAPI.storage.local.get("config");
		if (storedConfig.config) {
			config = { ...config, ...storedConfig.config };
		} else {
			await browserAPI.storage.local.set({ config });
		}

		// 統計データの読み込み
		const storedStats = await browserAPI.storage.local.get("stats");
		if (storedStats.stats) {
			// Mapオブジェクトの復元
			const restoredStats = storedStats.stats;

			stats.totalTimeSaved = restoredStats.totalTimeSaved || 0;
			stats.prefetchedPages = restoredStats.prefetchedPages || 0;
			stats.successfulPrefetches =
				restoredStats.successfulPrefetches || 0;

			if (restoredStats.visitedUrls) {
				stats.visitedUrls = new Map(
					JSON.parse(restoredStats.visitedUrls)
				);
			}

			if (restoredStats.navigationPatterns) {
				stats.navigationPatterns = new Map(
					JSON.parse(restoredStats.navigationPatterns)
				);
			}
		} else {
			await saveStats();
		}
	} catch (error) {
		console.error("データの読み込み中にエラーが発生しました:", error);
	}
}

// 統計データの保存
async function saveStats() {
	try {
		const serializableStats = {
			totalTimeSaved: stats.totalTimeSaved,
			prefetchedPages: stats.prefetchedPages,
			successfulPrefetches: stats.successfulPrefetches,
			visitedUrls: JSON.stringify([...stats.visitedUrls]),
			navigationPatterns: JSON.stringify([...stats.navigationPatterns]),
		};
		await browserAPI.storage.local.set({ stats: serializableStats });
	} catch (error) {
		console.error("統計データの保存中にエラーが発生しました:", error);
	}
}

// バッテリーステータスの更新
function updateBatteryStatus(battery) {
	sessionCache.batteryStatus = {
		charging: battery.charging,
		level: battery.level,
		chargingTime: battery.chargingTime,
		dischargingTime: battery.dischargingTime,
	};

	if (config.batterySaving && !battery.charging && battery.level < 0.3) {
		console.log("バッテリー残量が少ないため、プリフェッチが制限されます");
		// ここでプリフェッチの動作を制限するロジックを追加
	}
}

// ネットワーク接続状態の更新
function updateNetworkStatus(connection) {
	sessionCache.networkType = connection.type || "unknown";
	if (
		config.dataSaver &&
		(connection.type === "cellular" || connection.saveData)
	) {
		console.log(
			"データセーバーモードが有効なため、プリフェッチが制限されます"
		);
		// ここでプリフェッチの動作を制限するロジックを追加
	}
}

// URLのプリフェッチが許可されているかチェック
function isUrlAllowedForPrefetch(url) {
	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname;

		if (config.blacklist.some((pattern) => hostname.includes(pattern))) {
			return false;
		}

		if (config.whitelist.length > 0) {
			return config.whitelist.some((pattern) =>
				hostname.includes(pattern)
			);
		}

		return true;
	} catch (error) {
		console.error("URLの検証中にエラーが発生しました:", error);
		return false;
	}
}

// ページ遷移の記録と学習
function recordNavigation(fromUrl, toUrl) {
	const normalizeUrl = (url) => {
		try {
			const urlObj = new URL(url);
			return urlObj.origin + urlObj.pathname;
		} catch (error) {
			return url;
		}
	};

	const normFromUrl = normalizeUrl(fromUrl);
	const normToUrl = normalizeUrl(toUrl);

	if (normFromUrl === normToUrl) {
		return;
	}

	// 訪問URLの記録
	if (!stats.visitedUrls.has(normToUrl)) {
		stats.visitedUrls.set(normToUrl, 1);
	} else {
		stats.visitedUrls.set(normToUrl, stats.visitedUrls.get(normToUrl) + 1);
	}

	// 遷移パターンの記録
	if (!stats.navigationPatterns.has(normFromUrl)) {
		stats.navigationPatterns.set(normFromUrl, new Map([[normToUrl, 1]]));
	} else {
		const destinations = stats.navigationPatterns; //.get(normFromUrl);
		if (!destinations.has(normToUrl)) {
			destinations.set(normToUrl, 1);
		} else {
			destinations.set(normToUrl, destinations.get(normToUrl) + 1);
		}
	}

	saveStats();
}

// 次に訪問する可能性の高いURLを予測
function predictNextUrls(currentUrl) {
	const normalizeUrl = (url) => {
		try {
			const urlObj = new URL(url);
			return urlObj.origin + urlObj.pathname;
		} catch (error) {
			return url;
		}
	};

	const normCurrentUrl = normalizeUrl(currentUrl);
	const destinations = stats.navigationPatterns; //.get(normCurrentUrl);

	if (!destinations || destinations.size === 0) {
		return [];
	}

	// destinationsがMapであることを確認
	if (!(destinations instanceof Map)) {
		console.error("destinations is not a Map:", destinations);
		return [];
	}

	const sortedDestinations = [...destinations.entries()].sort(
		(a, b) => b[1] - a[1]
	);

	let maxPredictions;
	switch (config.prefetchLevel) {
		case "low":
			maxPredictions = 1;
			break;
		case "high":
			maxPredictions = 5;
			break;
		case "medium":
		default:
			maxPredictions = 3;
			break;
	}

	return sortedDestinations.slice(0, maxPredictions).map(([url, count]) => ({
		url,
		weight: count / [...destinations.values()].reduce((a, b) => a + b, 0),
	}));
}

// ページをプリフェッチ
async function prefetchUrls(urlsToPrefetch) {
	if (!config.isActive || urlsToPrefetch.length === 0) {
		return;
	}

	if (
		sessionCache.batteryStatus &&
		config.batterySaving &&
		!sessionCache.batteryStatus.charging &&
		sessionCache.batteryStatus.level < 0.3
	) {
		console.log("バッテリー残量が少ないため、プリフェッチをスキップします");
		return;
	}

	if (sessionCache.networkType === "cellular" && config.dataSaver) {
		console.log(
			"データセーバーモードが有効なため、プリフェッチをスキップします"
		);
		return;
	}

	for (const { url, weight } of urlsToPrefetch) {
		if (sessionCache.prefetchedUrls.has(url)) {
			continue;
		}
		if (!isUrlAllowedForPrefetch(url)) {
			continue;
		}

		try {
			const startTime = Date.now();

			const response = await fetch(url, {
				method: "GET",
				mode: "no-cors",
				credentials: "omit",
				cache: "force-cache",
				redirect: "follow",
				referrerPolicy: "no-referrer",
				headers: {
					Purpose: "prefetch",
					"X-PreCache-Predictor": "true",
				},
			});

			const endTime = Date.now();
			console.log(`プリフェッチ完了: ${url} (${endTime - startTime}ms)`);

			// 成功したプリフェッチを記録
			sessionCache.prefetchedUrls.add(url);
			sessionCache.pendingPrefetches.set(url, {
				timestamp: startTime,
				loadTime: endTime - startTime,
			});

			stats.prefetchedPages++;
		} catch (error) {
			console.error(
				`URLのプリフェッチ中にエラーが発生しました: ${url}`,
				error
			);
		}
	}

	saveStats();
}

// タブの遷移を監視してナビゲーションパターンを学習
browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status === "complete" && tab.url) {
		browserAPI.tabs.get(tabId, (updatedTab) => {
			const previousUrl = sessionCache.tabUrls?.get(tabId);
			if (previousUrl && previousUrl !== updatedTab.url) {
				recordNavigation(previousUrl, updatedTab.url);

				// プリフェッチ統計の更新
				if (sessionCache.pendingPrefetches.has(updatedTab.url)) {
					const prefetchInfo = sessionCache.pendingPrefetches.get(
						updatedTab.url
					);
					const actualNavigationTime =
						Date.now() - prefetchInfo.timestamp;

					if (actualNavigationTime < 30000) {
						// 30秒以内の遷移
						stats.successfulPrefetches++;
						stats.totalTimeSaved += prefetchInfo.loadTime;

						saveStats();
					}

					// 使用済みのエントリを削除
					sessionCache.pendingPrefetches.delete(updatedTab.url);
				}
			}

			if (!sessionCache.tabUrls) {
				sessionCache.tabUrls = new Map();
			}
			sessionCache.tabUrls.set(tabId, updatedTab.url);

			// 次のナビゲーション予測
			if (config.isActive) {
				const predictedUrls = predictNextUrls(updatedTab.url);
				if (predictedUrls.length > 0) {
					prefetchUrls(predictedUrls);
				}
			}
		});
	}
});

browserAPI.tabs.onRemoved.addListener((tabId) => {
	if (sessionCache.tabUrls) {
		sessionCache.tabUrls.delete(tabId);
	}
});

browserAPI.storage.onChanged.addListener((changes) => {
	if (changes.config) {
		config = changes.config.newValue;
		console.log("設定が更新されました", config);
	}
});

// メッセージハンドラ
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === "toggleActive") {
		config.isActive = message.isActive;
		browserAPI.storage.local.set({ config });
		sendResponse({ success: true });
	} else if (message.action === "getStats") {
		sendResponse({
			totalTimeSaved: stats.totalTimeSaved,
			prefetchedPages: stats.prefetchedPages,
			successfulPrefetches: stats.successfulPrefetches,
		});
	}

	return true;
});

initialize();
