// ==========================================
// TON CONNECT UI - HAMSTER KOMBAT STYLE
// Shows wallet selection modal, then connects
// ==========================================

(function() {
    'use strict';

    const CONFIG = {
        manifestUrl: 'https://goldhuntpro.vercel.app/tonconnect-manifest.json',
        botUsername: 'Goldhunt101bot',
        containerId: 'ton-connect',
        fallbackId: 'walletFallback'
    };

    let tonConnectUI = null;
    let isReady = false;

    // ==========================================
    // TELEGRAM WEBAPP
    // ==========================================
    const tg = window.Telegram?.WebApp;

    // ==========================================
    // FIX: Override window.open for Telegram WebView
    // This forces wallet links to open properly
    // ==========================================
    const originalOpen = window.open;
    window.open = function(url, target, features) {
        if (url && url.includes('tonkeeper') || url?.includes('tonhub')) {
            // Force _blank to prevent iframe issues
            return originalOpen.call(window, url, '_blank', features);
        }
        return originalOpen.call(window, url, target, features);
    };

    // ==========================================
    // INITIALIZE
    // ==========================================
    async function init() {
        if (isReady) return;

        // Wait for TON Connect UI to load
        if (!window.TON_CONNECT_UI?.TonConnectUI) {
            setTimeout(init, 500);
            return;
        }

        try {
            const container = document.getElementById(CONFIG.containerId);
            if (!container) {
                console.error('Container not found');
                return;
            }

            container.innerHTML = '';

            // ==========================================
            // CREATE TON CONNECT UI INSTANCE
            // ==========================================
            tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
                manifestUrl: CONFIG.manifestUrl,
                buttonRootId: CONFIG.containerId
            });

            // ==========================================
            // CRITICAL: Configure for Telegram Mini App
            // ==========================================
            if (tg) {
                tg.ready();
                tg.expand();

                // Use 'none' + manual handling (Hamster Kombat method)
                tonConnectUI.uiOptions = {
                    actionsConfiguration: {
                        returnStrategy: 'none',
                        twaReturnUrl: `https://t.me/${CONFIG.botUsername}?startapp=main`
                    }
                };
            }

            // ==========================================
            // HANDLE WALLET CONNECTION
            // ==========================================
            tonConnectUI.onStatusChange((wallet) => {
                if (wallet?.account) {
                    onWalletConnected(wallet);
                } else {
                    onWalletDisconnected();
                }
            });

            // Hide fallback
            const fallback = document.getElementById(CONFIG.fallbackId);
            if (fallback) fallback.style.display = 'none';

            isReady = true;
            console.log('✅ TON Connect ready');

        } catch (err) {
            console.error('Init error:', err);
            showFallback();
        }
    }

    // ==========================================
    // MANUAL CONNECT - Opens wallet selection modal
    // This is what Hamster Kombat does
    // ==========================================
    async function connect() {
        if (!isReady) {
            await init();
            setTimeout(connect, 1000);
            return;
        }

        try {
            // ==========================================
            // THIS OPENS THE WALLET SELECTION MODAL
            // Shows: Tonkeeper, Telegram Wallet, etc.
            // ==========================================
            await tonConnectUI.openModal();

        } catch (err) {
            console.error('Connect error:', err);
            
            // Fallback: Direct universal link
            const universalLink = 'https://app.tonkeeper.com/ton-connect?v=2&id=' + generateId();
            if (tg) {
                tg.openLink(universalLink, { try_instant_view: false });
            } else {
                window.location.href = universalLink;
            }
        }
    }

    // ==========================================
    // WALLET CONNECTED
    // ==========================================
    function onWalletConnected(wallet) {
        const address = wallet.account.address;
        
        // Store
        localStorage.setItem('ton_wallet_address', address);
        localStorage.setItem('ton_wallet_connected', 'true');

        // Update game state
        if (window.gameState) {
            window.gameState.walletAddress = address;
            window.gameState.walletConnected = true;
        }

        // Close any popups
        if (tg) tg.closeScanQrPopup();

        // Dispatch event
        window.dispatchEvent(new CustomEvent('tonWalletConnected', {
            detail: {
                address: address,
                userFriendly: formatAddress(address),
                wallet: wallet
            }
        }));

        // Show toast
        showToast('✅ Wallet Connected!');
        
        console.log('Wallet connected:', address);
    }

    // ==========================================
    // WALLET DISCONNECTED
    // ==========================================
    function onWalletDisconnected() {
        localStorage.removeItem('ton_wallet_address');
        localStorage.removeItem('ton_wallet_connected');

        if (window.gameState) {
            window.gameState.walletAddress = null;
            window.gameState.walletConnected = false;
        }

        window.dispatchEvent(new CustomEvent('tonWalletDisconnected'));

        showToast('🔌 Wallet Disconnected');
    }

    // ==========================================
    // DISCONNECT
    // ==========================================
    async function disconnect() {
        if (!tonConnectUI) return;
        try {
            await tonConnectUI.disconnect();
        } catch (e) {
            console.error(e);
        }
    }

    // ==========================================
    // GET STATE
    // ==========================================
    function getState() {
        const addr = localStorage.getItem('ton_wallet_address');
        return {
            connected: !!addr,
            address: addr,
            userFriendly: addr ? formatAddress(addr) : null
        };
    }

    // ==========================================
    // UTILS
    // ==========================================
    function formatAddress(addr) {
        if (!addr || addr.length < 10) return addr;
        return addr.slice(0, 6) + '...' + addr.slice(-4);
    }

    function generateId() {
        return Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    function showToast(msg) {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }
    }

    function showFallback() {
        const btn = document.getElementById(CONFIG.fallbackId);
        if (btn) {
            btn.style.display = 'block';
            btn.onclick = connect;
        }
    }

    // ==========================================
    // AUTO-INIT
    // ==========================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }

    // ==========================================
    // PUBLIC API
    // ==========================================
    window.TonConnectHamster = {
        init,
        connect,
        disconnect,
        getState,
        isReady: () => isReady
    };

})();
