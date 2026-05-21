const contractAddress = "0x8FFCB73Ff62d493cF569FcE2bb2d722A8668444E";

const abi = [
  "function mint(uint256 quantity) payable",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function mintPrice() view returns (uint256)",
  "function whitelist(address) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

let signer;
let contract;
let provider;
let mintQty   = 1;
let userAddress = null;

// ── IPFS gateways (fastest first) ────────────────────────────────────────────
const IPFS_GATEWAYS = [
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://nftstorage.link/ipfs/"
];

function ipfsToHttp(uri, gatewayIndex = 0) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace("ipfs://", "");
    return (IPFS_GATEWAYS[gatewayIndex] || IPFS_GATEWAYS[0]) + cid;
  }
  return uri;
}

function onImgError(imgEl, uri, attempt) {
  attempt = attempt || 1;
  if (attempt < IPFS_GATEWAYS.length) {
    imgEl.src = ipfsToHttp(uri, attempt);
    imgEl.setAttribute("data-attempt", attempt + 1);
  } else {
    imgEl.style.display = "none";
    imgEl.nextElementSibling.style.display = "flex";
  }
}

// ── Quantity control ──────────────────────────────────────────────────────────
function changeQty(delta) {
  mintQty = Math.max(1, Math.min(10, mintQty + delta));
  document.getElementById("qtyDisplay").textContent = mintQty;
}

// ── Wallet connection ─────────────────────────────────────────────────────────
async function connectWallet() {
  const btn    = document.getElementById("connectBtn");
  const addrEl = document.getElementById("walletAddress");

  if (window.location.protocol === "file:") {
    setStatus("Open with Live Server — right-click index.html → Open with Live Server.", "error");
    return;
  }
  if (!window.ethereum) {
    setStatus("MetaMask not found. Please install it.", "error");
    return;
  }

  try {
    btn.disabled    = true;
    btn.textContent = "Connecting…";

    await window.ethereum.request({ method: "eth_requestAccounts" });

    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer   = provider.getSigner();
    contract = new ethers.Contract(contractAddress, abi, signer);

    userAddress     = await signer.getAddress();
    const short     = userAddress.slice(0, 6) + "…" + userAddress.slice(-4);
    btn.textContent = "Connected";
    btn.style.background = "linear-gradient(135deg,#22c55e,#16a34a)";
    addrEl.textContent   = short;

    setStatus("Wallet connected!", "success");
    await loadMintInfo();
    await loadCollection();
    await fetchMyNFTs();

    window.ethereum.on("accountsChanged", () => location.reload());

  } catch (err) {
    console.error(err);
    btn.disabled    = false;
    btn.textContent = "Connect Wallet";
    setStatus("Connection rejected.", "error");
  }
}

// ── Load mint info (supply + price) ──────────────────────────────────────────
async function loadMintInfo() {
  try {
    const [minted, max, price] = await Promise.all([
      contract.totalMinted(),
      contract.maxSupply(),
      contract.mintPrice()
    ]);

    const remaining = max.toNumber() - minted.toNumber();

    // Update supply text in mint card
    const supplyEl = document.getElementById("mintSupply");
    if (supplyEl) {
      supplyEl.textContent = `${remaining} Remaining · ${max.toNumber()} Total Supply · ERC-721`;
    }

    // Update price display
    const priceEl = document.getElementById("mintPrice");
    if (priceEl) {
      const ethPrice = ethers.utils.formatEther(price);
      priceEl.textContent = `${ethPrice} ETH`;
    }

    // Disable mint if sold out
    if (remaining === 0) {
      const mintBtn = document.getElementById("mintBtn");
      mintBtn.disabled = true;
      mintBtn.textContent = "Sold Out";
    }

  } catch (err) {
    console.error("loadMintInfo error:", err);
  }
}

// ── Mint ──────────────────────────────────────────────────────────────────────
async function mintNFT() {
  if (!contract) {
    setStatus("Please connect your wallet first.", "error");
    return;
  }

  const mintBtn = document.getElementById("mintBtn");

  try {
    mintBtn.disabled  = true;
    mintBtn.innerHTML = '<span class="spinner"></span>Waiting for approval…';
    setStatus("", "");

    // ── Whitelist check ──
    const isWhitelisted = await contract.whitelist(userAddress);
    if (!isWhitelisted) {
      setStatus("Your wallet is not whitelisted. Contact the owner.", "error");
      mintBtn.innerHTML = "Mint NFT";
      mintBtn.disabled  = false;
      return;
    }

    // ── Supply check ──
    const [minted, max] = await Promise.all([contract.totalMinted(), contract.maxSupply()]);
    if (minted.toNumber() + mintQty > max.toNumber()) {
      setStatus(`Only ${max.toNumber() - minted.toNumber()} NFTs remaining.`, "error");
      mintBtn.innerHTML = "Mint NFT";
      mintBtn.disabled  = false;
      return;
    }

    // ── Fetch price from contract ──
    const pricePerToken = await contract.mintPrice();
    const totalValue    = pricePerToken.mul(mintQty);

    const tx = await contract.mint(mintQty, { value: totalValue });

    mintBtn.innerHTML = '<span class="spinner"></span>Minting…';
    setStatus(`Tx sent: ${tx.hash.slice(0, 10)}…`, "");

    const receipt = await tx.wait();

    // Extract minted token IDs directly from Transfer events in receipt
    const transferTopic = ethers.utils.id("Transfer(address,address,uint256)");
    const mintedTokenIds = receipt.logs
      .filter(log => log.address.toLowerCase() === contractAddress.toLowerCase()
                  && log.topics[0] === transferTopic)
      .map(log => ethers.BigNumber.from(log.topics[3]).toString());

    console.log("Minted token IDs:", mintedTokenIds);

    setStatus(`Minted ${mintQty} NFT${mintQty > 1 ? "s" : ""}! Loading…`, "success");
    mintBtn.innerHTML = "Mint NFT";
    mintBtn.disabled  = false;

    // Refresh supply display
    await loadMintInfo();
    await loadCollection();

    // Show only newly minted NFTs immediately
    if (mintedTokenIds.length > 0) {
      await showNFTsById(mintedTokenIds);
    } else {
      await fetchMyNFTs();
    }

    setStatus(`Minted ${mintQty} NFT${mintQty > 1 ? "s" : ""}! Loaded ✓`, "success");

  } catch (err) {
    console.error(err);
    const msg = err?.reason || err?.message || "Transaction failed.";
    setStatus(msg.length > 80 ? msg.slice(0, 80) + "…" : msg, "error");
    mintBtn.innerHTML = "Mint NFT";
    mintBtn.disabled  = false;
  }
}

// ── Load full collection (all minted NFTs) ────────────────────────────────────
async function loadCollection() {
  const section    = document.getElementById("collectionSection");
  const grid       = document.getElementById("collectionGrid");
  const loadingEl  = document.getElementById("collectionLoading");

  section.style.display   = "block";
  grid.innerHTML          = "";
  loadingEl.style.display = "flex";
  loadingEl.innerHTML     = `<span class="spinner" style="border-top-color:#a855f7;border-color:#3a1a5e"></span> Loading collection…`;

  try {
    const totalMinted = await contract.totalMinted();
    const count = totalMinted.toNumber();

    if (count === 0) {
      loadingEl.style.display = "none";
      grid.innerHTML = `<p class="no-nfts">No NFTs minted yet. Be the first!</p>`;
      return;
    }

    // Build array [1, 2, 3, ... count]
    const tokenIds = Array.from({ length: count }, (_, i) => (i + 1).toString());

    loadingEl.style.display = "none";
    await showNFTsInGrid(tokenIds, grid);

  } catch (err) {
    console.error("loadCollection error:", err);
    loadingEl.style.display = "none";
    grid.innerHTML = `<p class="no-nfts">Failed to load collection: ${err.message}</p>`;
  }
}

// ── Render NFT cards into a specific grid ─────────────────────────────────────
async function showNFTsInGrid(tokenIds, grid) {
  const metadataPromises = tokenIds.map(async (tokenId) => {
    let uri = null;
    try {
      uri = await contract.tokenURI(tokenId);
    } catch (e) {
      return { tokenId, metadata: null };
    }

    for (let g = 0; g < IPFS_GATEWAYS.length; g++) {
      try {
        const httpUri  = ipfsToHttp(uri, g);
        const response = await fetch(httpUri);
        if (!response.ok) continue;
        const metadata = await response.json();
        return { tokenId, metadata };
      } catch (e) {
        console.warn(`Gateway ${g} failed for token ${tokenId}`);
      }
    }
    return { tokenId, metadata: null };
  });

  const results = await Promise.all(metadataPromises);

  results.forEach(({ tokenId, metadata }) => {
    const card = document.createElement("div");
    card.className = "nft-card";

    if (!metadata) {
      card.innerHTML = `
        <div class="nft-placeholder">?</div>
        <div class="nft-info">
          <div class="nft-name">Token #${tokenId}</div>
          <div class="nft-desc">Metadata unavailable</div>
        </div>`;
    } else {
      const imgSrc     = ipfsToHttp(metadata.image, 0);
      const rawUri     = metadata.image;
      const traitsHTML = (metadata.attributes || [])
        .map(a => `<span class="trait-badge">${a.trait_type}: ${a.value}</span>`)
        .join("");

      card.innerHTML = `
        <img src="${imgSrc}" alt="${metadata.name}"
             data-uri="${rawUri}" data-attempt="1"
             onerror="onImgError(this, this.dataset.uri, parseInt(this.dataset.attempt))" />
        <div class="nft-placeholder" style="display:none">?</div>
        <div class="nft-info">
          <div class="nft-name">${metadata.name}</div>
          <div class="nft-desc">${metadata.description || ""}</div>
          <div class="nft-traits">${traitsHTML}</div>
        </div>`;
    }
    grid.appendChild(card);
  });
}

// ── Render NFT cards by token IDs (My NFTs section) ──────────────────────────
async function showNFTsById(tokenIds, append = false) {
  const section   = document.getElementById("myNFTsSection");
  const grid      = document.getElementById("myNFTsGrid");
  const loadingEl = document.getElementById("nftLoading");

  section.style.display   = "block";
  loadingEl.style.display = "flex";
  loadingEl.innerHTML     = `<span class="spinner" style="border-top-color:#a855f7;border-color:#3a1a5e"></span> Loading your NFTs…`;
  if (!append) grid.innerHTML = "";

  await showNFTsInGrid(tokenIds, grid);

  loadingEl.style.display = "flex";
  loadingEl.innerHTML = `<span style="color:#4ade80; font-size:0.9rem;">✓ ${tokenIds.length} NFT${tokenIds.length > 1 ? "s" : ""} Loaded</span>`;
}

// ── Fetch all NFTs owned via Transfer events ──────────────────────────────────
async function fetchMyNFTs() {
  const section   = document.getElementById("myNFTsSection");
  const grid      = document.getElementById("myNFTsGrid");
  const loadingEl = document.getElementById("nftLoading");

  section.style.display   = "block";
  grid.innerHTML          = "";
  loadingEl.style.display = "flex";

  try {
    const balance = await contract.balanceOf(userAddress);
    const count   = balance.toNumber();

    if (count === 0) {
      loadingEl.style.display = "none";
      grid.innerHTML = `<p class="no-nfts">You don't own any NFTs yet. Mint one above!</p>`;
      return;
    }

    // Scan Transfer events — use recent block range to avoid RPC timeout
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = Math.max(0, latestBlock - 100000); // last ~100k blocks

    // Tokens received by user
    const filterIn  = contract.filters.Transfer(null, userAddress);
    const eventsIn  = await contract.queryFilter(filterIn, fromBlock, "latest");

    // Tokens sent away by user
    const filterOut = contract.filters.Transfer(userAddress, null);
    const eventsOut = await contract.queryFilter(filterOut, fromBlock, "latest");

    // Build set of tokens user currently owns (received - sent)
    const receivedSet = new Set();
    eventsIn.forEach(e  => receivedSet.add(e.args.tokenId.toString()));

    const sentSet = new Set();
    eventsOut.forEach(e => sentSet.add(e.args.tokenId.toString()));

    // Only keep tokens that were received and NOT sent away
    const ownedTokens = Array.from(receivedSet).filter(id => !sentSet.has(id));

    loadingEl.style.display = "none";

    if (ownedTokens.length === 0) {
      grid.innerHTML = `<p class="no-nfts">Could not find your NFTs. Try minting first.</p>`;
      return;
    }

    // Safety check — show only up to what balanceOf says
    await showNFTsById(ownedTokens.slice(0, count));

  } catch (err) {
    console.error("fetchMyNFTs error:", err);
    loadingEl.style.display = "none";
    grid.innerHTML = `<p class="no-nfts">Failed to load NFTs: ${err.message}</p>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type) {
  const el    = document.getElementById("status");
  el.textContent = msg;
  el.className   = type;
}
