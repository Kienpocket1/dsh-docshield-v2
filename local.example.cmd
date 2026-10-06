@echo off
rem Cau hinh rieng cua ban cai dat nay. Chep thanh local.cmd (khong dua vao git) roi sua.
rem Hai ban tren cung mot may phai khac nhau o TOOL_PREFIX va TOOL_IMAGE / MAIN_IMAGE
rem (prefix = ten volume, mang, container: khac prefix thi khong dung chung du lieu).
rem Muon chay hai ban CUNG LUC thi GATE_PORT va TOOL_MANAGER_PORT cung phai khac.
set "TOOL_PREFIX=congty"
set "GATE_PORT=3454"
set "TOOL_MANAGER_PORT=3470"
set "TOOL_IMAGE=congty-tools:dev"
set "MAIN_IMAGE=congty-dsh-main:dev"
rem Lan dau: de trong = tao ban sach; hoac duong dan runtime Windows cu de chep du lieu sang.
set "RUNTIME_DIR="
rem Ma nguon DeepSeek Harness (chi doc) de build image.
set "DSH_SOURCE=E:\Deepseek_Harness\deepseek-harness"
rem Ban sach: volume co san mo hinh nhung de chep (chi doc thu muc .docshield/models); de trong = khong chep.
set "MODEL_FROM=docshield-storage"
rem Han muc dia moi nguoi (MB).
set "TOOL_QUOTA_MB=1024"
