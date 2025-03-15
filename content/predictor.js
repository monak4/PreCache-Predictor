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
			// リンクが存在しない、または無効な場合はスキップ
			if (
				!linkData.element ||
				!document.body.contains(linkData.element)
			) {
				return;
			}

			// 基本スコアの計算
			let score = 0;

			// 1. 可視性に基づくスコア
			if (linkData.isVisible) {
				score += ANALYSIS_CONFIG.analyzePriorityFactor.visibility;

				// 画面中央に近いリンクにはボーナス
				const centerDistanceY = Math.abs(linkData.position.y - 0.5);
				if (centerDistanceY < 0.3) {
					// 中央付近の要素にはボーナス
					score +=
						(0.3 - centerDistanceY) *
						ANALYSIS_CONFIG.analyzePriorityFactor.position;
				}
			}

			// 2. サイズに基づくスコア（大きなリンクは重要である可能性が高い）
			const viewportArea = window.innerWidth * window.innerHeight;
			const relativeSize = linkData.size.area / viewportArea;
			if (relativeSize > 0.005) {
				// 画面の0.5%以上を占めるリンク
				score +=
					Math.min(relativeSize * 10, 0.1) *
					ANALYSIS_CONFIG.analyzePriorityFactor.relativeSize;
			}

			// 3. ユーザーインタラクションに基づくスコア
			// クリック履歴
			if (linkData.clickCount > 0) {
				score +=
					Math.min(linkData.clickCount * 0.5, 1) *
					ANALYSIS_CONFIG.analyzePriorityFactor.clicks;
			}

			// ホバー履歴
			if (linkData.hoverCount > 0) {
				score +=
					Math.min(linkData.hoverCount * 0.3, 1) *
					ANALYSIS_CONFIG.analyzePriorityFactor.hovers;
			}

			// 4. リンクのテキスト内容に基づく分析
			const linkText = linkData.element.textContent.trim();
			if (linkText) {
				// 特定のキーワードに基づく重み付け
				const importantKeywords = [
					"次へ",
					"続き",
					"詳細",
					"もっと見る",
					"読む",
					"表示",
					"next",
					"more",
					"continue",
					"read",
					"view",
					"details",
				];

				for (const keyword of importantKeywords) {
					if (
						linkText.toLowerCase().includes(keyword.toLowerCase())
					) {
						score += 0.15;
						break;
					}
				}
			}

			// ページ内セマンティクス分析
			// 階層構造での重要性（見出し近くのリンクはより重要）
			const isNearHeading = !!linkData.element.closest(
				"h1, h2, h3, h4, h5, h6, header, .header, .title"
			);
			if (isNearHeading) {
				score += 0.15;
			}

			// 親コンテナの重要性
			const isInMainContent = !!linkData.element.closest(
				"main, article, .content, .main, #content, #main"
			);
			if (isInMainContent) {
				score += 0.1;
			}

			// スコアとURLを記録
			scoredLinks.push({
				url,
				score,
				linkData,
			});
		} catch (error) {
			console.error(
				`リンクの分析中にエラーが発生しました (${url}):`,
				error
			);
		}
	});

	// URLをスコアで降順ソート
	scoredLinks.sort((a, b) => b.score - a.score);

	// 最上位の予測を返す
	return scoredLinks
		.slice(0, ANALYSIS_CONFIG.maxLinksToReport)
		.map((item) => ({
			url: item.url,
			weight: item.score,
			isVisible: item.linkData.isVisible,
			interacted:
				item.linkData.clickCount > 0 || item.linkData.hoverCount > 0,
		}));
}

// ページを離れる際のクリーンアップ
function cleanupPageAnalysis() {
	// MutationObserverのクリーンアップ
	if (pageAnalysisState.domObserver) {
		pageAnalysisState.domObserver.disconnect();
		pageAnalysisState.domObserver = null;
	}

	// イベントリスナーの削除（明示的に登録された場合）
	// 注: 通常、ページ遷移時には自動的にクリーンアップされるが、念のため

	// その他のリソースのクリーンアップ
	hoverTimers.forEach((timerId) => clearTimeout(timerId));
	hoverTimers.clear();

	// 状態のリセット
	pageAnalysisState.links.clear();
}

// ページ内のセマンティクス分析
function analyzePageSemantics() {
	// ページのタイトル
	const pageTitle = document.title;

	// メタディスクリプション
	const metaDescription =
		document.querySelector('meta[name="description"]')?.content || "";

	// 見出し要素
	const headings = Array.from(document.querySelectorAll("h1, h2, h3")).map(
		(h) => h.textContent.trim()
	);

	// キーワード頻度分析
	const mainContent =
		document.querySelector("main, article, #content, .content") ||
		document.body;
	const textContent = mainContent.textContent.toLowerCase();

	// シンプルな単語頻度分析
	const words = textContent.split(/\s+/).filter((word) => word.length > 3);
	const wordFrequency = {};

	words.forEach((word) => {
		if (!wordFrequency[word]) {
			wordFrequency[word] = 1;
		} else {
			wordFrequency[word]++;
		}
	});

	// 最も頻度の高い単語
	const topKeywords = Object.entries(wordFrequency)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([word]) => word);

	return {
		title: pageTitle,
		description: metaDescription,
		headings: headings.slice(0, 5), // 最初の5つの見出しのみ
		keywords: topKeywords,
	};
}

// ページコンテキストをバックグラウンドに送信
function sendPageContextToBackground() {
	const semantics = analyzePageSemantics();

	browserAPI.runtime.sendMessage({
		action: "pageContext",
		currentUrl: window.location.href,
		context: {
			title: semantics.title,
			description: semantics.description,
			keywords: semantics.keywords,
			headings: semantics.headings,
		},
	});
}

// URLのカテゴリを推測
function categorizeUrl(url) {
	try {
		const urlObj = new URL(url);
		const path = urlObj.pathname;

		// パスが短すぎる場合はスキップ
		if (path.length <= 1) {
			return "home";
		}

		// カテゴリを推測する単純なヒューリスティック
		if (
			path.includes("/blog/") ||
			path.includes("/news/") ||
			path.includes("/article/")
		) {
			return "article";
		}

		if (
			path.includes("/product/") ||
			path.includes("/item/") ||
			path.match(/\/p\/\d+/)
		) {
			return "product";
		}

		if (path.includes("/category/") || path.includes("/tag/")) {
			return "category";
		}

		if (path.includes("/search")) {
			return "search";
		}

		if (
			path.includes("/account") ||
			path.includes("/profile") ||
			path.includes("/user")
		) {
			return "account";
		}

		// URLパターンの正規表現チェック
		if (path.match(/\/\d{4}\/\d{2}\/\d{2}\//)) {
			return "article"; // 日付形式の記事URL
		}

		if (path.match(/\/[a-z0-9-]+\/[a-z0-9-]+$/)) {
			// カテゴリ/スラッグ形式のURLの場合、記事である可能性が高い
			return "article";
		}

		return "other";
	} catch (error) {
		console.error("URL分類中にエラーが発生しました:", error);
		return "unknown";
	}
}

// メッセージリスナーの設定
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.action === "requestPageAnalysis") {
		// バックグラウンドが分析を要求
		const predictions = analyzePredictedUrls();
		const semantics = analyzePageSemantics();

		sendResponse({
			predictions,
			context: {
				title: semantics.title,
				description: semantics.description,
				keywords: semantics.keywords,
			},
		});
	}

	// 応答が非同期の場合は、trueを返す
	return true;
});

// ページ内のプリフェッチヒント（<link rel="prefetch">）を検出して報告
function detectExistingPrefetchHints() {
	const prefetchLinks = document.querySelectorAll(
		'link[rel="prefetch"], link[rel="prerender"]'
	);

	if (prefetchLinks.length > 0) {
		const hints = Array.from(prefetchLinks).map((link) => link.href);

		// 既存のヒントをバックグラウンドに報告
		browserAPI.runtime.sendMessage({
			action: "existingPrefetchHints",
			currentUrl: window.location.href,
			hints,
		});
	}
}

// インターセクションオブザーバーを使用して、可視領域に入ったリンクを追跡
function setupVisibilityObserver() {
	// サポートされていない環境ではスキップ
	if (!("IntersectionObserver" in window)) {
		return;
	}

	const visibilityObserver = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				const link = entry.target;
				if (!link.href) return;

				if (pageAnalysisState.links.has(link.href)) {
					const linkData = pageAnalysisState.links.get(link.href);
					linkData.isVisible = entry.isIntersecting;

					// 可視状態が変わったとき（特に可視になったとき）
					if (entry.isIntersecting) {
						linkData.visibleSince = Date.now();
					} else if (linkData.visibleSince) {
						linkData.totalVisibleTime =
							(linkData.totalVisibleTime || 0) +
							(Date.now() - linkData.visibleSince);
						linkData.visibleSince = null;
					}

					pageAnalysisState.links.set(link.href, linkData);
				}
			});
		},
		{
			threshold: [0, 0.5, 1.0],
			rootMargin: "0px",
		}
	);

	// すべてのリンクを監視
	document.querySelectorAll("a[href]").forEach((link) => {
		if (
			link.href &&
			!link.href.startsWith("javascript:") &&
			!link.href.startsWith("#")
		) {
			visibilityObserver.observe(link);
		}
	});

	// 後でクリーンアップできるように保存
	pageAnalysisState.visibilityObserver = visibilityObserver;
}

// ページ訪問のコンテキストに基づく分析
function analyzePageContext() {
	// 現在のURLを分析
	const currentUrl = window.location.href;
	const urlCategory = categorizeUrl(currentUrl);

	// リファラー情報の分析
	const referrer = document.referrer;
	let referrerCategory = "direct";

	if (referrer) {
		try {
			const referrerUrl = new URL(referrer);
			const currentUrl = new URL(window.location.href);

			// 同じドメインからの訪問
			if (referrerUrl.hostname === currentUrl.hostname) {
				referrerCategory = "internal";
				// 内部参照元のカテゴリを取得
				const internalCategory = categorizeUrl(referrer);

				// ナビゲーションパターンの分析
				// 例: カテゴリーページから商品ページへ、など
				if (
					internalCategory === "category" &&
					urlCategory === "product"
				) {
					// カテゴリからの商品閲覧
					browserAPI.runtime.sendMessage({
						action: "navigationPattern",
						pattern: "category_to_product",
						fromUrl: referrer,
						toUrl: currentUrl.href,
					});
				} else if (
					internalCategory === "search" &&
					urlCategory === "product"
				) {
					// 検索結果からの商品閲覧
					browserAPI.runtime.sendMessage({
						action: "navigationPattern",
						pattern: "search_to_product",
						fromUrl: referrer,
						toUrl: currentUrl.href,
					});
				}
			} else {
				referrerCategory = "external";

				// 主要なソースを検出
				const hostname = referrerUrl.hostname;
				if (hostname.includes("google")) {
					referrerCategory = "search";
				} else if (
					hostname.includes("facebook") ||
					hostname.includes("twitter") ||
					hostname.includes("instagram") ||
					hostname.includes("linkedin")
				) {
					referrerCategory = "social";
				}
			}
		} catch (error) {
			console.error("リファラー分析中にエラーが発生しました:", error);
		}
	}

	// ページコンテキストをバックグラウンドに送信
	browserAPI.runtime.sendMessage({
		action: "visitContext",
		currentUrl: window.location.href,
		context: {
			category: urlCategory,
			referrer: referrer || "none",
			referrerCategory: referrerCategory,
			timestamp: Date.now(),
		},
	});
}

// 初期化
initializePageAnalysis();
setTimeout(detectExistingPrefetchHints, 1000);
setTimeout(sendPageContextToBackground, 2000);
setTimeout(analyzePageContext, 2500);
setTimeout(setupVisibilityObserver, 3000);

console.log("PreCache Predictor - Content Script が初期化されました");
