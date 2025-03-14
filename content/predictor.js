// PreCache Predictor - Content Script
// This script analyzes page content to predict potential navigation targets

const browserAPI = typeof chrome !== "undefined" ? chrome : browser;

// 設定とページ解析のステート
let pageAnalysisState = {
	links: new Map(), // URL → {element, position, isVisible, clickCount}
	lastScrollPosition: 0,
	lastHoveredElements: [],
	domObserver: null,
	pageLoadTime: Date.now(),
	userInteractions: {
		clicks: [],
		hovers: [],
		scrollDepth: 0,
		dwellTime: 0,
	},
};

// リンク解析の設定
const ANALYSIS_CONFIG = {
	visibleThreshold: 0.5, // リンクが何パーセント表示されたら「可視」と見なすか
	scrollMonitorInterval: 250, // スクロール監視の間隔 (ms)
	dwellTimeInterval: 5000, // 滞在時間計測の間隔 (ms)
	maxLinksToReport: 20, // 一度に報告する最大リンク数
	hoverThreshold: 300, // ホバーと見なす時間閾値 (ms)
	analyzePriorityFactor: {
		visibility: 0.3,
		position: 0.2,
		relativeSize: 0.1,
		clicks: 0.25,
		hovers: 0.15,
	},
};

// ページ初期化
function initializePageAnalysis() {
	// 既存のページ分析をクリーン
	cleanupPageAnalysis();

	// 初期状態の設定
	pageAnalysisState.pageLoadTime = Date.now();
	pageAnalysisState.lastScrollPosition = window.scrollY;

	// リンクの検出と追跡
	collectPageLinks();

	// DOM変更監視の設定
	setupDomObserver();

	// イベントリスナーの設定
	setupEventListeners();

	// 定期的な分析と報告
	setupAnalysisInterval();

	// ページの離脱時の処理を設定
	setupPageUnloadListener();

	// 5秒後に最初の分析結果を送信
	setTimeout(sendPredictionsToBackground, 5000);
}

// DOM変更監視
function setupDomObserver() {
	const observerConfig = {
		childList: true,
		subtree: true,
	};

	pageAnalysisState.domObserver = new MutationObserver((mutations) => {
		let shouldUpdateLinks = false;

		for (const mutation of mutations) {
			if (
				mutation.type === "childList" &&
				mutation.addedNodes.length > 0
			) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType === Node.ELEMENT_NODE) {
						// リンクが追加されたかチェック
						if (
							node.tagName === "A" ||
							node.querySelectorAll("a").length > 0
						) {
							shouldUpdateLinks = true;
							break;
						}
					}
				}
			}

			if (shouldUpdateLinks) break;
		}

		if (shouldUpdateLinks) {
			// 追加されたリンクのみを収集
			collectPageLinks(true);
		}
	});

	pageAnalysisState.domObserver.observe(document.body, observerConfig);
}

// イベントリスナーの設定
function setupEventListeners() {
	// スクロールイベントの監視（スロットリング）
	let scrollTimeout;
	window.addEventListener(
		"scroll",
		(e) => {
			if (!scrollTimeout) {
				scrollTimeout = setTimeout(() => {
					handleScroll();
					scrollTimeout = null;
				}, ANALYSIS_CONFIG.scrollMonitorInterval);
			}
		},
		{ passive: true }
	);

	// クリックイベントの監視
	document.addEventListener("click", handleClick, true);

	// マウスのホバー監視
	document.addEventListener("mouseover", handleMouseOver, true);
	document.addEventListener("mouseout", handleMouseOut, true);
}

// スクロールハンドラー
function handleScroll() {
	const currentScrollY = window.scrollY;
	const viewportHeight = window.innerHeight;
	const documentHeight = document.documentElement.scrollHeight;

	// スクロール深度を計算（0〜1）
	const scrollDepth = Math.min(
		(currentScrollY + viewportHeight) / documentHeight,
		1
	);

	// 最大スクロール深度を更新
	if (scrollDepth > pageAnalysisState.userInteractions.scrollDepth) {
		pageAnalysisState.userInteractions.scrollDepth = scrollDepth;
	}

	// 可視リンクの更新
	updateVisibleLinks();

	pageAnalysisState.lastScrollPosition = currentScrollY;
}

// クリックハンドラー
function handleClick(event) {
	const target = event.target.closest("a");
	if (!target) return;

	const url = target.href;
	if (!url || url.startsWith("javascript:") || url.startsWith("#")) return;

	// クリックされたリンクを記録
	if (pageAnalysisState.links.has(url)) {
		const linkData = pageAnalysisState.links.get(url);
		linkData.clickCount = (linkData.clickCount || 0) + 1;
		pageAnalysisState.links.set(url, linkData);

		// クリックイベントを記録
		pageAnalysisState.userInteractions.clicks.push({
			url,
			timestamp: Date.now(),
		});

		// 最大10件のクリックを保持
		if (pageAnalysisState.userInteractions.clicks.length > 10) {
			pageAnalysisState.userInteractions.clicks.shift();
		}

		// クリックしたリンクを即座に報告
		sendImportantPredictionToBackground(url);
	}
}

// マウスオーバーハンドラー
let hoverTimers = new Map();

function handleMouseOver(event) {
	const target = event.target.closest("a");
	if (!target) return;

	const url = target.href;
	if (!url || url.startsWith("javascript:") || url.startsWith("#")) return;

	// このリンク上のホバー開始時間を記録
	const hoverTimer = setTimeout(() => {
		if (pageAnalysisState.links.has(url)) {
			const linkData = pageAnalysisState.links.get(url);
			linkData.hoverCount = (linkData.hoverCount || 0) + 1;
			pageAnalysisState.links.set(url, linkData);

			// ホバーイベントを記録
			pageAnalysisState.userInteractions.hovers.push({
				url,
				timestamp: Date.now(),
				duration: ANALYSIS_CONFIG.hoverThreshold,
			});

			// 最大10件のホバーを保持
			if (pageAnalysisState.userInteractions.hovers.length > 10) {
				pageAnalysisState.userInteractions.hovers.shift();
			}
		}
	}, ANALYSIS_CONFIG.hoverThreshold);

	hoverTimers.set(url, hoverTimer);
}

function handleMouseOut(event) {
	const target = event.target.closest("a");
	if (!target) return;

	const url = target.href;
	if (!url) return;

	// このリンク上のホバータイマーをクリア
	if (hoverTimers.has(url)) {
		clearTimeout(hoverTimers.get(url));
		hoverTimers.delete(url);
	}
}

// ページ内のすべてのリンクを収集
function collectPageLinks(incrementalUpdate = false) {
	// 初回でない場合は既存のリンクを保持
	if (!incrementalUpdate) {
		pageAnalysisState.links.clear();
	}

	const links = document.querySelectorAll("a");

	for (const link of links) {
		const url = link.href;

		// 有効なURLのみを処理
		if (
			!url ||
			url === "" ||
			url === "#" ||
			url.startsWith("javascript:")
		) {
			continue;
		}

		// 既に追跡済みのリンクは除外
		if (incrementalUpdate && pageAnalysisState.links.has(url)) {
			continue;
		}

		try {
			// リンクの位置情報を取得
			const rect = link.getBoundingClientRect();
			const viewportHeight = window.innerHeight;
			const viewportWidth = window.innerWidth;

			// 相対的な位置（0〜1の範囲）
			const relativePosition = {
				x: (rect.left + rect.right) / 2 / viewportWidth,
				y: (rect.top + rect.bottom) / 2 / viewportHeight,
			};

			// リンクがビューポート内にあるかどうか
			const isVisible = isElementVisible(link);

			// リンク情報を格納
			pageAnalysisState.links.set(url, {
				element: link,
				position: relativePosition,
				size: {
					width: rect.width,
					height: rect.height,
					area: rect.width * rect.height,
				},
				isVisible,
				firstSeen: Date.now(),
				clickCount: 0,
				hoverCount: 0,
			});
		} catch (error) {
			console.error("リンク分析中にエラーが発生しました:", error);
		}
	}

	// 可視リンクのステータスを更新
	updateVisibleLinks();
}

// 要素が現在表示されているかどうかを判定
function isElementVisible(element) {
	if (!element.offsetParent && element.offsetParent !== document.body) {
		return false; // 非表示要素
	}

	const rect = element.getBoundingClientRect();

	// 要素のサイズがゼロの場合
	if (rect.width === 0 || rect.height === 0) {
		return false;
	}

	// ビューポート内に一部でも含まれているか
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;

	// 要素がビューポート外にある場合
	if (
		rect.bottom < 0 ||
		rect.top > viewportHeight ||
		rect.right < 0 ||
		rect.left > viewportWidth
	) {
		return false;
	}

	// 要素がビューポート内にある場合、表示されている割合を計算
	const visibleHeight =
		Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
	const visibleWidth =
		Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);

	const visibleArea = visibleHeight * visibleWidth;
	const totalArea = rect.width * rect.height;

	// 要素の特定の割合以上が表示されているかどうか
	return visibleArea / totalArea >= ANALYSIS_CONFIG.visibleThreshold;
}

// 可視リンクのステータスを更新
function updateVisibleLinks() {
	pageAnalysisState.links.forEach((linkData, url) => {
		// リンクが有効かどうかチェック（DOMから削除された可能性も考慮）
		if (!linkData.element || !document.body.contains(linkData.element)) {
			return;
		}

		// 可視性のステータスを更新
		linkData.isVisible = isElementVisible(linkData.element);

		// 位置情報を更新
		const rect = linkData.element.getBoundingClientRect();
		const viewportHeight = window.innerHeight;
		const viewportWidth = window.innerWidth;

		linkData.position = {
			x: (rect.left + rect.right) / 2 / viewportWidth,
			y: (rect.top + rect.bottom) / 2 / viewportHeight,
		};
	});
}

// 定期的な分析の設定
function setupAnalysisInterval() {
	// 滞在時間の計測と更新
	setInterval(() => {
		pageAnalysisState.userInteractions.dwellTime +=
			ANALYSIS_CONFIG.dwellTimeInterval / 1000;

		// 滞在時間が30秒を超えたら予測を更新
		if (pageAnalysisState.userInteractions.dwellTime % 30 === 0) {
			sendPredictionsToBackground();
		}
	}, ANALYSIS_CONFIG.dwellTimeInterval);
}

// ページを離れる際の処理
function setupPageUnloadListener() {
	window.addEventListener("beforeunload", () => {
		// 最終的な分析データを送信
		sendPageAnalyticsToBackground();

		// リソースのクリーンアップ
		cleanupPageAnalysis();
	});
}

// 予測URLをバックグラウンドに送信
function sendPredictionsToBackground() {
	const predictions = analyzePredictedUrls();

	// 予測結果をバックグラウンドに送信
	browserAPI.runtime.sendMessage({
		action: "contentPredictions",
		currentUrl: window.location.href,
		predictions: predictions,
		userInteractions: {
			scrollDepth: pageAnalysisState.userInteractions.scrollDepth,
			dwellTime: pageAnalysisState.userInteractions.dwellTime,
		},
	});
}

// 重要な予測（クリック直後など）をバックグラウンドに送信
function sendImportantPredictionToBackground(url) {
	browserAPI.runtime.sendMessage({
		action: "importantPrediction",
		currentUrl: window.location.href,
		predictedUrl: url,
		confidence: 0.9, // クリックされたのでConfidenceを高く設定
	});
}

// ページ分析データをバックグラウンドに送信
function sendPageAnalyticsToBackground() {
	const sessionDuration =
		(Date.now() - pageAnalysisState.pageLoadTime) / 1000;

	browserAPI.runtime.sendMessage({
		action: "pageAnalytics",
		currentUrl: window.location.href,
		sessionData: {
			duration: sessionDuration,
			scrollDepth: pageAnalysisState.userInteractions.scrollDepth,
			clicks: pageAnalysisState.userInteractions.clicks,
			hovers: pageAnalysisState.userInteractions.hovers,
		},
	});
}

// リンクを分析して予測URLを生成
function analyzePredictedUrls() {
	// スコアリングされたリンクの配列を作成
	const scoredLinks = [];

	pageAnalysisState.links.forEach((linkData, url) => {
		try {
		// リンクが存在しない、または無効な場合は