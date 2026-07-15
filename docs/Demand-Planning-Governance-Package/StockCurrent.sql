USE [3PPOS]
GO
/****** Object:  StoredProcedure [dbo].[sp_StockCurrent]    Script Date: 7/13/2026 3:56:27 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO


ALTER PROCEDURE [dbo].[sp_StockCurrent]
AS
BEGIN

update dbo.tbl_OPSImExMaster
set EffDate=CONVERT(date,EffDate)
where EffDate<>CONVERT(date,EffDate)

update dbo.tbl_OPSImExMaster
set ReceiptDate=CONVERT(date,ReceiptDate)
where ReceiptDate<>CONVERT(date,ReceiptDate)

update tbl_LSProduct
set Quantity=0
where Quantity is null

delete tbl_SYSProductStockTemp

insert into tbl_SYSProductStockTemp
select code, Quantity,0 from tbl_LSProduct

update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty + b.Qty
from (SELECT     dbo.tbl_OPSImExDetails.Product, SUM(dbo.tbl_OPSImExDetails.QtyReceived) AS Qty
FROM         dbo.tbl_OPSImExDetails INNER JOIN
                      dbo.tbl_OPSImExMaster ON dbo.tbl_OPSImExDetails.DocumentNo = dbo.tbl_OPSImExMaster.Code
WHERE     (dbo.tbl_OPSImExMaster.DocumentType in (1,2,3,4,21,31, 41, 50) and tbl_OPSImExMaster.DocumentStatus=3)
GROUP BY dbo.tbl_OPSImExDetails.Product) b
where tbl_SYSProductStockTemp.Code=b.Product

update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty + b.Qty
from (SELECT     dbo.tbl_OPSImExDetails.Product, SUM(dbo.tbl_OPSImExDetails.Quantity) AS Qty
FROM         dbo.tbl_OPSImExDetails INNER JOIN
                      dbo.tbl_OPSImExMaster ON dbo.tbl_OPSImExDetails.DocumentNo = dbo.tbl_OPSImExMaster.Code
WHERE     (dbo.tbl_OPSImExMaster.DocumentType in (1,2,3,4,21,31, 41, 50) and tbl_OPSImExMaster.DocumentStatus=2)
GROUP BY dbo.tbl_OPSImExDetails.Product) b
where tbl_SYSProductStockTemp.Code=b.Product


update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty - b.Qty
from (SELECT     dbo.tbl_OPSImExDetails.Product, SUM(dbo.tbl_OPSImExDetails.QtyReceived) AS Qty
FROM         dbo.tbl_OPSImExDetails INNER JOIN
                      dbo.tbl_OPSImExMaster ON dbo.tbl_OPSImExDetails.DocumentNo = dbo.tbl_OPSImExMaster.Code
WHERE     (dbo.tbl_OPSImExMaster.DocumentType in (5,6,7,8,9,10,20,30, 40, 52) and tbl_OPSImExMaster.DocumentStatus=6)
GROUP BY dbo.tbl_OPSImExDetails.Product) b
where tbl_SYSProductStockTemp.Code=b.Product

update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty - b.Qty
from (SELECT     dbo.tbl_OPSImExDetails.Product, SUM(dbo.tbl_OPSImExDetails.QtyReceived) AS Qty
FROM         dbo.tbl_OPSImExDetails INNER JOIN
                      dbo.tbl_OPSImExMaster ON dbo.tbl_OPSImExDetails.DocumentNo = dbo.tbl_OPSImExMaster.Code
WHERE     (dbo.tbl_OPSImExMaster.DocumentType in (5,6,7,8,9,20,30, 40, 52) and tbl_OPSImExMaster.DocumentStatus=5)
GROUP BY dbo.tbl_OPSImExDetails.Product) b
where tbl_SYSProductStockTemp.Code=b.Product

update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty - b.Qty
from (
SELECT     dbo.tbl_SALPoSDetails.Product, SUM(dbo.tbl_SALPoSDetails.Qty) AS Qty
FROM         dbo.tbl_SALPoSDetails INNER JOIN
                      dbo.tbl_SALPoSMaster ON dbo.tbl_SALPoSDetails.PoSMaster = dbo.tbl_SALPoSMaster.Code
WHERE     (dbo.tbl_SALPoSMaster.TransactionType = 2 and tbl_SALPoSDetails.RePosDetails is null)
GROUP BY dbo.tbl_SALPoSDetails.Product)b
where tbl_SYSProductStockTemp.Code=b.Product

update tbl_SYSProductStockTemp
set tbl_SYSProductStockTemp.NewQty= tbl_SYSProductStockTemp.NewQty + b.Qty
from (
SELECT     dbo.tbl_SALPoSDetails.Product, SUM(dbo.tbl_SALPoSDetails.Qty) AS Qty
FROM         dbo.tbl_SALPoSDetails INNER JOIN
                      dbo.tbl_SALPoSMaster ON dbo.tbl_SALPoSDetails.PoSMaster = dbo.tbl_SALPoSMaster.Code
WHERE     (dbo.tbl_SALPoSMaster.TransactionType = 3) or (dbo.tbl_SALPoSMaster.TransactionType = 2 and tbl_SALPoSDetails.RePosDetails is not null)
GROUP BY dbo.tbl_SALPoSDetails.Product)b
where tbl_SYSProductStockTemp.Code=b.Product

update tbl_LSProduct
set Quantity=  tbl_SYSProductStockTemp.NewQty
from tbl_SYSProductStockTemp
where tbl_SYSProductStockTemp.Code=tbl_LSProduct.Code
and tbl_SYSProductStockTemp.Qty<> tbl_SYSProductStockTemp.NewQty

END





