// ==========================================
// TON CONNECT UI - HAMSTER KOMBAT STYLE
// Standalone module for Telegram Mini Apps
// ==========================================

(function() {
    'use strict';

    // ==========================================
    // CONFIGURATION
    // ==========================================
    const CONFIG = {
        manifestUrl: 'https://goldhuntpro.vercel.app/tonconnect-manifest.json',
        botUsername: 'Goldhunt101bot',
        fallbackButtonId: 'walletFallback',
        containerId: 'ton-connect'
    };

    // ==========================================
    // STATE
    // ==========================================
    let tonConnectUI = null;
    let isInitialized = false;
    let connectionCheckInterval = null;

    // ==========================================
    // TELEGRAM WEBAPP UTILS
    // ==========================================
    const tg = window.Telegram?.WebApp || null;

    function isTelegramWebApp() {
        return !!tg;
    }

    function getTelegramUser() {
        return tg?.initDataUnsafe?.user || null;
    }

    function getStartParam() {
        return tg?.initDataUnsafe?.start_param || null;
    }

    function closePopup() {
        if (tg) {
            tg.closeScanQrPopup();
        }
    }

    function expandApp() {
        if (tg) {
            tg.ready();
            tg.expand();
        }
    }

    // ==========================================
    // WALLET CONNECTION DETECTOR
    // Polls for wallet connection status changes
    // ==========================================
    function startConnectionPolling() {
        if (connectionCheckInterval) clearInterval(connectionCheckInterval);
        
        let lastWalletState = null;
        
        connectionCheckInterval = setInterval(() => {
            if (!tonConnectUI) return;
            
            const wallet = tonConnectUI.wallet;
            const hasWallet = !!wallet?.account;
            
            if (hasWallet !== lastWalletState) {
                lastWalletState = hasWallet;
                
                if (hasWallet) {
                    handleWalletConnected(wallet);
                } else {
                    handleWalletDisconnected();
                }
            }
        }, 1000);
    }

    // ==========================================
    // INITIALIZE TON CONNECT UI
    // ==========================================
    function initTonConnect() {
        if (isInitialized) return Promise.resolve();
        
        return new Promise((resolve, reject) => {
            const checkAndInit = () => {
                if (!window.TON_CONNECT_UI?.TonConnectUI) {
                    setTimeout(checkAndInit, 500);
                    return;
                }

                try {
                    const container = document.getElementById(CONFIG.containerId);
                    if (!container) {
                        reject(new Error('Container not found: #' + CONFIG.containerId));
                        return;
                    }

                    container.innerHTML = '';

                    // ==========================================
                    // CRITICAL: Use 'none' returnStrategy
                    // 'back' is broken in Telegram WebView
                    // ==========================================
                    const returnUrl = isTelegramWebApp() 
                        ? `https://t.me/${CONFIG.botUsername}?startapp=${getStartParam() || 'main'}`
                        : window.location.href;

                    tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
                        manifestUrl: CONFIG.manifestUrl,
                        buttonRootId: CONFIG.containerId
                    });

                    // Configure for Telegram Mini App
                    if (isTelegramWebApp()) {
                        tonConnectUI.uiOptions = {
                            actionsConfiguration: {
                                returnStrategy: 'none',
                                twaReturnUrl: returnUrl
                            }
                        };
                    }

                    // Status change handler
                    tonConnectUI.onStatusChange((wallet) => {
                        if (wallet?.account) {
                            handleWalletConnected(wallet);
                        } else {
                            handleWalletDisconnected();
                        }
                    });

                    // Start polling as backup
                    startConnectionPolling();

                    // Hide fallback button
                    const fallback = document.getElementById(CONFIG.fallbackButtonId);
                    if (fallback) fallback.style.display = 'none';

                    isInitialized = true;
                    console.log('✅ TON Connect UI initialized');
                    resolve();

                } catch (error) {
                    console.error('❌ TON Connect init error:', error);
                    showFallbackButton();
                    reject(error);
                }
            };

            checkAndInit();
        });
    }

    // ==========================================
    // MANUAL CONNECT (Fallback)
    // ==========================================
    async function connectWalletManual() {
        if (!isInitialized) {
            await initTonConnect();
            setTimeout(connectWalletManual, 1000);
            return;
        }

        try {
            await tonConnectUI.openModal();
        } catch (error) {
            console.error('Manual connect error:', error);
            
            // Last resort: Open Telegram Wallet directly
            if (isTelegramWebApp()) {
                tg.openLink('https://t.me/wallet?attach=wallet', { 
                    try_instant_view: false 
                });
            }
        }
    }

    // ==========================================
    // WALLET EVENT HANDLERS
    // ==========================================
    function handleWalletConnected(wallet) {
        const address = wallet.account.address;
        const userFriendlyAddress = formatAddress(address);
        
        // Store in localStorage
        localStorage.setItem('ton_wallet_address', address);
        localStorage.setItem('ton_wallet_connected', 'true');
        localStorage.setItem('ton_wallet_connected_at', new Date().toISOString());

        // Store in game state (if available)
        if (window.gameState) {
            window.gameState.walletAddress = address;
            window.gameState.walletConnected = true;
        }

        // Close any popups
        closePopup();

        // Dispatch custom event
        window.dispatchEvent(new CustomEvent('tonWalletConnected', {
            detail: { address, userFriendlyAddress, wallet }
        }));

        console.log('✅ Wallet connected:', userFriendlyAddress);
    }

    function handleWalletDisconnected() {
        localStorage.removeItem('ton_wallet_address');
        localStorage.removeItem('ton_wallet_connected');
        localStorage.removeItem('ton_wallet_connected_at');

        if (window.gameState) {
            window.gameState.walletAddress = null;
            window.gameState.walletConnected = false;
        }

        window.dispatchEvent(new CustomEvent('tonWalletDisconnected'));

        console.log('🔌 Wallet disconnected');
    }

    // ==========================================
    // DISCONNECT WALLET
    // ==========================================
    async function disconnectWallet() {
        if (!tonConnectUI) return;
        
        try {
            await tonConnectUI.disconnect();
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    }

    // ==========================================
    // GET WALLET STATE
    // ==========================================
    function getWalletState() {
        const address = localStorage.getItem('ton_wallet_address');
        const connected = localStorage.getItem('ton_wallet_connected') === 'true';
        
        return {
            connected,
            address,
            userFriendlyAddress: address ? formatAddress(address) : null
        };
    }

    // ==========================================
    // FORMAT ADDRESS (Shorten)
    // ==========================================
    function formatAddress(address) {
        if (!address || address.length < 10) return address;
        return address.slice(0, 6) + '...' + address.slice(-4);
    }

    // ==========================================
    // SHOW/HIDE FALLBACK BUTTON
    // ==========================================
    function showFallbackButton() {
        const fallback = document.getElementById(CONFIG.fallbackButtonId);
        if (fallback) {
            fallback.style.display = 'block';
            fallback.onclick = connectWalletManual;
        }
    }

    // ==========================================
    // RESTORE WALLET CONNECTION
    // Check if wallet was previously connected
    // ==========================================
    async function restoreWalletConnection() {
        const state = getWalletState();
        
        if (state.connected && state.address) {
            // Verify connection is still valid
            if (tonConnectUI?.wallet?.account?.address === state.address) {
                handleWalletConnected(tonConnectUI.wallet);
                return true;
            }
        }
        
        return false;
    }

    // ==========================================
    // AUTO-INITIALIZE
    // ==========================================
    function autoInit() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                expandApp();
                initTonConnect().then(() => {
                    restoreWalletConnection();
                }).catch(console.error);
            });
        } else {
            expandApp();
            initTonConnect().then(() => {
                restoreWalletConnection();
            }).catch(console.error);
        }
    }

    // ==========================================
    // EXPOSE PUBLIC API
    // ==========================================
    window.TonConnectModule = {
        init: initTonConnect,
        connect: connectWalletManual,
        disconnect: disconnectWallet,
        getState: getWalletState,
        isReady: () => isInitialized,
        getUI: () => tonConnectUI
    };

    // Auto-start
    autoInit();

})();
